import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

let tempDir: string;

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

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-playlist-link-"));
  process.env.LOG_DIR = tempDir;
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("playlist entries from import jobs", () => {
  test("a re-claimed job keeps one entry, and a taken position is logged and not overwritten", async () => {
    // The stored YouTube ids skip yt-dlp and MusicBrainz, so the probe needs no network.
    const databasePath = join(tempDir, "test.sqlite");
    const setup = new Database(databasePath);
    setup.exec(
      await Bun.file(
        new URL("./fixtures/playlist-schema.sql", import.meta.url),
      ).text(),
    );
    const now = Date.now();
    setup.run(
      `INSERT INTO tracks_table (id, youtube_id, title, first_release_date, length, file_path, created_at, updated_at)
      VALUES ('track-a', 'abcdefghijk', 'A', 0, 1000, 'audio/a.opus', ?, ?), ('track-b', 'lmnopqrstuv', 'B', 0, 1000, 'audio/b.opus', ?, ?)`,
      [now, now, now, now],
    );
    setup.run(
      `INSERT INTO playlists (id, name, created_at, updated_at) VALUES ('pl-1', 'Import', ?, ?)`,
      [now, now],
    );
    setup.run(
      `INSERT INTO imports (id, source_url, mode, playlist_id, created_at, updated_at) VALUES ('imp-1', 'https://example.test', 'playlist', 'pl-1', ?, ?)`,
      [now, now],
    );
    setup.run(
      `INSERT INTO jobs (id, url, status, created_at, updated_at, import_id, position) VALUES
      ('job-0', 'https://youtube.com/watch?v=abcdefghijk', 'queued', ?, ?, 'imp-1', 0),
      ('job-conflict', 'https://youtube.com/watch?v=lmnopqrstuv', 'queued', ?, ?, 'imp-1', 0)`,
      [now, now, now, now],
    );
    setup.close();

    const probe = join(tempDir, "probe.ts");
    const ingestTrackModule = join(
      process.cwd(),
      "src/services/ingestTrack.ts",
    );
    await writeFile(
      probe,
      `const { ingestTrack } = await import(${JSON.stringify(ingestTrackModule)});
await ingestTrack("https://youtube.com/watch?v=abcdefghijk", "job-0");
await ingestTrack("https://youtube.com/watch?v=abcdefghijk", "job-0");
await ingestTrack("https://youtube.com/watch?v=lmnopqrstuv", "job-conflict");
`,
    );
    const child = Bun.spawn(["bun", probe], {
      cwd: process.cwd(),
      env: { ...process.env, DB_FILE_NAME: databasePath, LOG_DIR: tempDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const check = new Database(databasePath, { readonly: true });
    const entries = check
      .query("SELECT track_id, position FROM playlist_tracks ORDER BY position")
      .all() as any[];
    const jobTracks = check
      .query("SELECT id, track_id FROM jobs ORDER BY id")
      .all() as any[];
    check.close();
    expect(entries).toEqual([{ track_id: "track-a", position: 0 }]);
    expect(jobTracks).toEqual([
      { id: "job-0", track_id: "track-a" },
      { id: "job-conflict", track_id: "track-b" },
    ]);

    const all = await records();
    expect(
      all.filter((r) => r.event === "playlist_entry_already_present"),
    ).toHaveLength(1);
    const taken = all.filter((r) => r.event === "playlist_position_taken");
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatchObject({
      level: "warning",
      jobId: "job-conflict",
      occupiedBy: "track-a",
      position: 0,
    });
  });
});
