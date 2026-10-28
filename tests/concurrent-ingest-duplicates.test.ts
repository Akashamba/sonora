import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// Two jobs for the same video, or two videos that resolve to one recording, racing each
// other. The probe runs in a child process with a temp DB, a fake yt-dlp on PATH and a
// stubbed MusicBrainz fetch, so no network or real library is touched.

const originalPath = process.env.PATH;
let tempDir: string;
let binDir: string;
let downloadLog: string;

const now = Date.now();
const positions = { first: 1, second: 4 };

const todayLog = () =>
  join(
    process.env.LOG_DIR!,
    `ingest-${new Date().toLocaleDateString("en-CA")}.jsonl`,
  );
async function records() {
  try {
    return (await readFile(todayLog(), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// Downloads wait this long, so jobs that start together both pass the duplicate checks
// before either one writes its track.
const FAKE_DOWNLOAD_SECONDS = "1.5";

const fakeYtDlp = `#!/bin/sh
# Fake yt-dlp. --dump-json answers with fixed metadata. A download waits, then writes a small
# file at the -o path with the extension set to opus.
mode=""; out=""; prev=""
for arg in "$@"; do
  case "$arg" in
    --dump-json) mode=meta ;;
    -f) mode=download ;;
  esac
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
  url="$arg"
done
id="\${url##*v=}"
if [ "$mode" = "meta" ]; then
  echo '{"title":"Blurred","track":"Blurred","artist":"Kiasmos","album":"Blurred","duration":240,"upload_date":"20140101"}'
  exit 0
fi
echo "$id" >> "$FAKE_DOWNLOAD_LOG"
sleep "$FAKE_DOWNLOAD_SECONDS"
stem=$(echo "$out" | sed 's/\\.%(ext)s$//')
mkdir -p "$(dirname "$stem")"
printf 'audio %s' "$id" > "$stem.opus"
`;

// Runs one job list through settleJob, the same wrapper the worker uses.
const probe = (ingestTrackModule: string, settleJobModule: string) => `
globalThis.fetch = (async (input) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "musicbrainz.org") return new Response("not found", { status: 404 });
  const recording = {
    id: "rec-blurred",
    title: "Blurred",
    length: 240000,
    score: 100,
    "first-release-date": "2014-01-01",
    "artist-credit": [{ name: "Kiasmos", joinphrase: "", artist: { id: "artist-kiasmos", name: "Kiasmos", "sort-name": "Kiasmos" } }],
    releases: [{ id: "rel-blurred", title: "Blurred", date: "2014-01-01", status: "Official", "release-group": { id: "rg-blurred", "primary-type": "Album", title: "Blurred" } }],
  };
  return new Response(JSON.stringify({ count: 1, recordings: [recording] }), { headers: { "content-type": "application/json" } });
});
const { ingestTrack } = await import(${JSON.stringify(ingestTrackModule)});
const { settleJob } = await import(${JSON.stringify(settleJobModule)});
const jobs = JSON.parse(process.env.PROBE_JOBS);
await Promise.all(
  jobs.map((job) =>
    settleJob({ id: job.id, url: job.url }, (progress) => ingestTrack(job.url, job.id, progress, {})),
  ),
);
`;

type JobRow = { id: string; url: string; position: number };

async function setupDatabase(jobRows: JobRow[]) {
  const databasePath = join(tempDir, "test.sqlite");
  const setup = new Database(databasePath);
  setup.exec(
    await Bun.file(
      new URL("./fixtures/playlist-schema.sql", import.meta.url),
    ).text(),
  );
  setup.run(
    `INSERT INTO playlists (id, name, created_at, updated_at) VALUES ('pl-1', 'Blurred', ?, ?)`,
    [now, now],
  );
  setup.run(
    `INSERT INTO imports (id, source_url, mode, playlist_id, created_at, updated_at) VALUES ('imp-1', 'https://example.test', 'playlist', 'pl-1', ?, ?)`,
    [now, now],
  );
  for (const job of jobRows) {
    setup.run(
      `INSERT INTO jobs (id, url, status, created_at, updated_at, import_id, position) VALUES (?, ?, 'running', ?, ?, 'imp-1', ?)`,
      [job.id, job.url, now, now, job.position],
    );
  }
  setup.close();
  return databasePath;
}

// Each child process is one worker. Two calls to this run two workers at once.
async function runWorker(databasePath: string, jobs: JobRow[]) {
  const probePath = join(tempDir, `probe-${crypto.randomUUID()}.ts`);
  await writeFile(
    probePath,
    probe(
      join(process.cwd(), "src/services/ingestTrack.ts"),
      join(process.cwd(), "src/workers/ingestTrack/settleJob.ts"),
    ),
  );
  const child = Bun.spawn(["bun", probePath], {
    cwd: tempDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${originalPath}`,
      DB_FILE_NAME: databasePath,
      LOG_DIR: tempDir,
      FAKE_DOWNLOAD_LOG: downloadLog,
      FAKE_DOWNLOAD_SECONDS,
      MUSICBRAINZ_MIN_INTERVAL_MS: "0",
      PROBE_JOBS: JSON.stringify(jobs),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr };
}

function readState(databasePath: string) {
  const check = new Database(databasePath, { readonly: true });
  try {
    return {
      tracks: check
        .query(
          "SELECT id, youtube_id, musicbrainz_recording_id, file_path FROM tracks_table",
        )
        .all() as any[],
      jobs: check
        .query("SELECT id, status, error, track_id FROM jobs ORDER BY id")
        .all() as any[],
      entries: check
        .query(
          "SELECT track_id, position FROM playlist_tracks ORDER BY position",
        )
        .all() as any[],
    };
  } finally {
    check.close();
  }
}

async function downloadCount() {
  try {
    return (await readFile(downloadLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-concurrent-ingest-"));
  process.env.LOG_DIR = tempDir;
  binDir = join(tempDir, "bin");
  downloadLog = join(tempDir, "downloads.log");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "yt-dlp"), fakeYtDlp);
  await chmod(join(binDir, "yt-dlp"), 0o755);
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  process.env.PATH = originalPath;
});

const audioFiles = async () => (await readdir(join(tempDir, "audio"))).sort();

describe("concurrent ingests of the same work", () => {
  test("one process, same video twice: one download, both jobs linked and completed", async () => {
    const rows = [
      {
        id: "job-first",
        url: "https://youtube.com/watch?v=abcdefghijk",
        position: positions.first,
      },
      {
        id: "job-second",
        url: "https://youtube.com/watch?v=abcdefghijk",
        position: positions.second,
      },
    ];
    const databasePath = await setupDatabase(rows);
    const result = await runWorker(databasePath, rows);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);

    expect(await downloadCount()).toBe(1);
    const state = readState(databasePath);
    expect(state.tracks).toHaveLength(1);
    expect(state.jobs.map((j) => [j.id, j.status, j.error])).toEqual([
      ["job-first", "completed", null],
      ["job-second", "completed", null],
    ]);
    const trackId = state.tracks[0].id;
    expect(state.jobs.map((j) => j.track_id)).toEqual([trackId, trackId]);
    expect(state.entries).toEqual([
      { track_id: trackId, position: positions.first },
      { track_id: trackId, position: positions.second },
    ]);
    expect(await audioFiles()).toEqual(["Blurred_abcdefghijk.opus"]);

    const all = await records();
    expect(
      all.some(
        (r) =>
          r.event === "ingest_waited_for_youtube_id" &&
          r.jobId === "job-second",
      ),
    ).toBe(true);
    expect(all.filter((r) => r.event === "job_marked_failed")).toHaveLength(0);
  }, 30000);

  test("two processes, same video: the insert hits the unique index, the job completes and keeps the shared file", async () => {
    const rowsA = [
      {
        id: "job-a",
        url: "https://youtube.com/watch?v=abcdefghijk",
        position: positions.first,
      },
    ];
    const rowsB = [
      {
        id: "job-b",
        url: "https://youtube.com/watch?v=abcdefghijk",
        position: positions.second,
      },
    ];
    const databasePath = await setupDatabase([...rowsA, ...rowsB]);
    const [a, b] = await Promise.all([
      runWorker(databasePath, rowsA),
      runWorker(databasePath, rowsB),
    ]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);

    const state = readState(databasePath);
    expect(state.tracks).toHaveLength(1);
    expect(state.jobs.map((j) => [j.id, j.status, j.error])).toEqual([
      ["job-a", "completed", null],
      ["job-b", "completed", null],
    ]);
    const trackId = state.tracks[0].id;
    expect(state.entries).toEqual([
      { track_id: trackId, position: positions.first },
      { track_id: trackId, position: positions.second },
    ]);
    // The stored track still points at the file, so it must not be deleted.
    expect(await audioFiles()).toEqual(["Blurred_abcdefghijk.opus"]);

    const all = await records();
    const skipped = all.filter((r) => r.event === "ingest_skipped_duplicate");
    expect(skipped).toHaveLength(1);
    // Either process can lose the insert race, so the loser is not fixed to one job.
    expect(["job-a", "job-b"]).toContain(skipped[0].jobId);
    expect(skipped[0]).toMatchObject({
      detectedAt: "insert",
      fileRemoved: false,
      level: "info",
    });
    // Same video, so the recording matches as well.
    expect(skipped[0].matchedBy).toEqual(["youtube_id", "recording_id"]);
    expect(
      all.filter(
        (r) =>
          r.event === "database_transaction_failed" &&
          // Both unique indexes are hit, and SQLite names whichever it checks first.
          ["youtube_id", "musicbrainz_recording_id"].includes(r.conflict),
      ),
    ).toHaveLength(1);
    expect(all.filter((r) => r.event === "job_marked_failed")).toHaveLength(0);
  }, 30000);

  test("one process, two videos resolving to one recording: loser links, completes and its file is removed", async () => {
    const rows = [
      {
        id: "job-one",
        url: "https://youtube.com/watch?v=aaaaaaaaaaa",
        position: positions.first,
      },
      {
        id: "job-two",
        url: "https://youtube.com/watch?v=bbbbbbbbbbb",
        position: positions.second,
      },
    ];
    const databasePath = await setupDatabase(rows);
    const result = await runWorker(databasePath, rows);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);

    expect(await downloadCount()).toBe(2);
    const state = readState(databasePath);
    expect(state.tracks).toHaveLength(1);
    const winner = state.tracks[0];
    expect(winner.musicbrainz_recording_id).toBe("rec-blurred");
    expect(state.jobs.map((j) => [j.id, j.status, j.error])).toEqual([
      ["job-one", "completed", null],
      ["job-two", "completed", null],
    ]);
    expect(state.jobs.map((j) => j.track_id)).toEqual([winner.id, winner.id]);
    expect(state.entries).toEqual([
      { track_id: winner.id, position: positions.first },
      { track_id: winner.id, position: positions.second },
    ]);
    // Only the winner's file remains. The loser's file had no track row, so it was removed.
    expect(await audioFiles()).toEqual([
      winner.file_path.replace("audio/", ""),
    ]);

    const all = await records();
    const skipped = all.filter((r) => r.event === "ingest_skipped_duplicate");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      detectedAt: "insert",
      fileRemoved: true,
    });
    expect(skipped[0].matchedBy).toEqual(["recording_id"]);
    expect(all.filter((r) => r.event === "job_marked_failed")).toHaveLength(0);
  }, 30000);
});
