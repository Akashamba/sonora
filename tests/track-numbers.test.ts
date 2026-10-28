import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { trackPositionOnRelease } from "../src/utils/trackPosition";

let tempDir: string;
let databasePath: string;
let server: Bun.Subprocess | undefined;
let base: string;

const schemaSql = () =>
  Bun.file(new URL("./fixtures/playlist-schema.sql", import.meta.url)).text();

// Runs code in a child process with its own DB_FILE_NAME, so the module-level db
// connection points at the temp database and never at a real one.
async function runProbe(body: string) {
  const probe = join(tempDir, `probe-${crypto.randomUUID()}.ts`);
  await writeFile(
    probe,
    `const { db } = await import(${JSON.stringify(join(process.cwd(), "src/server/db/index.ts"))});
${body}
`,
  );
  const child = Bun.spawn(["bun", probe], {
    cwd: process.cwd(),
    env: { ...process.env, DB_FILE_NAME: databasePath, LOG_DIR: tempDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return stdout;
}

function resultOf(stdout: string) {
  const line = stdout.split("\n").find((text) => text.startsWith("RESULT "));
  return JSON.parse(line!.slice("RESULT ".length));
}

async function api(method: string, path: string) {
  const res = await fetch(`${base}${path}`, { method });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

// Album tracks inserted out of album order. t-e has a disc but no track number,
// t-c has neither, so both should come last.
const ALBUM = [
  { id: "t-a", disc: 1, track: 2 },
  { id: "t-b", disc: 2, track: 1 },
  { id: "t-c", disc: null, track: null },
  { id: "t-d", disc: 1, track: 1 },
  { id: "t-e", disc: null, track: 1 },
];
const ALBUM_ORDER = ["t-d", "t-a", "t-b", "t-e", "t-c"];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-track-numbers-"));
  databasePath = join(tempDir, "test.sqlite");
  const setup = new Database(databasePath);
  setup.exec(await schemaSql());
  const now = Date.now();
  setup.run(
    "INSERT INTO release_groups_table (id, musicbrainz_primary_type, title, first_release_date, created_at, updated_at) VALUES ('rg-album', 'Album', 'Album', 0, ?, ?)",
    [now, now],
  );
  for (const [i, t] of ALBUM.entries()) {
    setup.run(
      `INSERT INTO tracks_table (id, youtube_id, release_group_id, title, first_release_date, length, file_path, disc_number, track_number, created_at, updated_at)
       VALUES (?, ?, 'rg-album', ?, 0, 1000, ?, ?, ?, ?, ?)`,
      [
        t.id,
        `yt-${i}`,
        `Song ${t.id}`,
        `audio/${t.id}.opus`,
        t.disc,
        t.track,
        now,
        now,
      ],
    );
  }
  setup.close();
});

afterEach(async () => {
  server?.kill();
  server = undefined;
  await rm(tempDir, { recursive: true, force: true });
});

describe("trackPositionOnRelease", () => {
  const release = {
    media: [
      { position: 1, tracks: [{ position: 1, recording: { id: "rec-1" } }] },
      {
        position: 2,
        tracks: [
          { position: 1, recording: { id: "rec-2" } },
          { position: 3, recording: { id: "rec-3" } },
        ],
      },
    ],
  };

  test("returns the medium and the track position of the recording", () => {
    expect(trackPositionOnRelease(release, "rec-3")).toEqual({
      disc_number: 2,
      track_number: 3,
    });
    expect(trackPositionOnRelease(release, "rec-1")).toEqual({
      disc_number: 1,
      track_number: 1,
    });
  });

  test("returns null when the release has no track listing or the recording is not on it", () => {
    expect(
      trackPositionOnRelease(
        { media: [{ position: 1, "track-count": 12 }] },
        "rec-1",
      ),
    ).toBeNull();
    expect(trackPositionOnRelease({}, "rec-1")).toBeNull();
    expect(trackPositionOnRelease(release, "rec-missing")).toBeNull();
    expect(trackPositionOnRelease(release, null)).toBeNull();
  });
});

describe("addNewTrack stores disc and track numbers", () => {
  test("an album release with a track listing stores both numbers; a search release without one stores null", async () => {
    const out = await runProbe(`
const { addNewTrack } = await import(${JSON.stringify(join(process.cwd(), "src/server/db/transactions/addNewTrack.ts"))});
const artist = { name: "Artist", joinphrase: "", artist: { id: "artist-x", name: "Artist" } };
const recording = (id) => ({ id, title: "Song " + id, "first-release-date": "2019", length: 123, "artist-credit": [artist] });
await addNewTrack({
  release: {
    date: "2020-05-01",
    "release-group": { id: "rg-new", "primary-type": "Album", title: "New" },
    media: [
      { position: 1, tracks: [{ position: 1, recording: { id: "rec-n1" } }] },
      { position: 2, tracks: [{ position: 3, recording: { id: "rec-n2" } }] },
    ],
  },
  youtubeId: "yt-new-1",
  filePath: "audio/new-1.opus",
  recording: recording("rec-n2"),
}, { jobId: "job-1" });
await addNewTrack({
  release: { date: "2020-05-01", "release-group": { id: "rg-new", "primary-type": "Album", title: "New" } },
  youtubeId: "yt-new-2",
  filePath: "audio/new-2.opus",
  recording: recording("rec-n3"),
}, { jobId: "job-2" });
console.log("RESULT done");
`);
    expect(out).toContain("RESULT");
    const rows = new Database(databasePath, { readonly: true })
      .query(
        "SELECT youtube_id, disc_number, track_number FROM tracks_table WHERE youtube_id LIKE 'yt-new-%' ORDER BY youtube_id",
      )
      .all();
    expect(rows).toEqual([
      { youtube_id: "yt-new-1", disc_number: 2, track_number: 3 },
      { youtube_id: "yt-new-2", disc_number: null, track_number: null },
    ]);
  });
});

describe("album track order", () => {
  test("fetchReleaseWithTracks sorts by disc, then track, nulls last, and exposes the numbers", async () => {
    const out = await runProbe(`
const { fetchReleaseWithTracks } = await import(${JSON.stringify(join(process.cwd(), "src/server/db/queries/fetchReleaseWithTracks.ts"))});
console.log("RESULT " + JSON.stringify(fetchReleaseWithTracks("rg-album").tracks));
`);
    const tracks = resultOf(out) as any[];
    expect(tracks.map((t) => t.id)).toEqual(ALBUM_ORDER);
    expect(tracks.find((t) => t.id === "t-b")).toMatchObject({
      disc_number: 2,
      track_number: 1,
    });
    expect(tracks.find((t) => t.id === "t-c")).toMatchObject({
      disc_number: null,
      track_number: null,
    });
  });

  test("POST /release-groups/:id/queue queues the album in the same order", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    base = `http://127.0.0.1:${port}`;
    server = Bun.spawn(["bun", "src/server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_FILE_NAME: databasePath,
        BIND_HOST: "127.0.0.1",
        BIND_PORT: String(port),
        DEMO_MODE: "false",
        LOG_DIR: tempDir,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await fetch(`${base}/`);
        break;
      } catch (error) {
        if (attempt > 100) throw error;
        await Bun.sleep(100);
      }
    }
    const res = await api("POST", "/release-groups/rg-album/queue");
    expect(res.status).toBe(200);
    const queued = new Database(databasePath, { readonly: true })
      .query("SELECT track_id FROM queue_table ORDER BY position")
      .all()
      .map((r: any) => r.track_id);
    expect(queued).toEqual(ALBUM_ORDER);
    expect(res.json.data.track_id).toBe(ALBUM_ORDER[0]!);
  });
});
