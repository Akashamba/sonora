import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalPath = process.env.PATH;
let tempDir: string;

const todayLog = () =>
  join(process.env.LOG_DIR!, `ingest-${new Date().toLocaleDateString("en-CA")}.jsonl`);
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
async function fakeYtDlp(script: string) {
  const bin = join(tempDir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "yt-dlp"), `#!/bin/sh\n${script}\n`);
  await chmod(join(bin, "yt-dlp"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-duplicate-log-"));
  process.env.LOG_DIR = tempDir;
  process.env.PATH = originalPath;
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  process.env.PATH = originalPath;
});

describe("duplicate detection logging", () => {
  test("the matched keys reach the jsonl file", async () => {
    // Runs in a child process with its own DB_FILE_NAME, as in download-file-logging.test.ts.
    // The first upload reuses the stored YouTube id and is skipped by the early check. The second has
    // a new YouTube id and is skipped after MusicBrainz returns the stored recording id.
    await fakeYtDlp(`cat <<'EOF'\n{"title":"Artist - Song","upload_date":"20200102"}\nEOF`);
    const databasePath = join(tempDir, "test.sqlite");
    const probe = join(tempDir, "probe.ts");
    const ingestTrackModule = join(process.cwd(), "src/services/ingestTrack.ts");
    const dbModule = join(process.cwd(), "src/server/db/index.ts");
    const schemaModule = join(process.cwd(), "src/server/db/schema.ts");
    await writeFile(
      probe,
      `import { sql } from "drizzle-orm";
const { db } = await import(${JSON.stringify(dbModule)});
const { tracks } = await import(${JSON.stringify(schemaModule)});
const { ingestTrack } = await import(${JSON.stringify(ingestTrackModule)});
await db.run(sql\`CREATE TABLE IF NOT EXISTS tracks_table (
  id text PRIMARY KEY NOT NULL,
  youtube_id text NOT NULL UNIQUE,
  musicbrainz_recording_id text UNIQUE,
  release_group_id text,
  title text NOT NULL,
  first_release_date integer NOT NULL,
  length integer NOT NULL,
  file_path text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
)\`);
await db.insert(tracks).values({
  id: "track-owner",
  youtube_id: "abcdefghijk",
  musicbrainz_recording_id: "rec-dup",
  title: "Song",
  first_release_date: new Date("2020-01-01"),
  length: 1000,
  file_path: "audio/Song.m4a",
});
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ count: 1, recordings: [{ id: "rec-dup", score: "92", title: "Song", "artist-credit": [{ name: "Artist" }] }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
await ingestTrack("https://youtube.com/watch?v=abcdefghijk", "job-both");
await ingestTrack("https://youtube.com/watch?v=lmnopqrstuv", "job-recording");
`,
    );
    const child = Bun.spawn(["bun", probe], {
      cwd: process.cwd(),
      env: { ...process.env, DB_FILE_NAME: databasePath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const all = await records();
    const skipped = all.filter((r) => r.event === "ingest_skipped_duplicate");
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toMatchObject({
      level: "info",
      jobId: "job-both",
      youtubeId: "abcdefghijk",
      stage: "youtube_id_check",
      matchCount: 1,
      matchedBy: ["youtube_id"],
      matchedTrackIds: ["track-owner"],
    });
    expect(skipped[1]).toMatchObject({
      jobId: "job-recording",
      youtubeId: "lmnopqrstuv",
      stage: "duplicate_check",
      matchCount: 1,
      matchedBy: ["recording_id"],
      matchedTrackIds: ["track-owner"],
    });
  });

  test("a stored YouTube id is skipped before any yt-dlp or MusicBrainz call", async () => {
    // yt-dlp leaves a marker and fetch throws, so either call would show up.
    const ytDlpMarker = join(tempDir, "yt-dlp-called");
    await fakeYtDlp(`touch ${ytDlpMarker}; cat <<'EOF'\n{"title":"Artist - Song","upload_date":"20200102"}\nEOF`);
    const databasePath = join(tempDir, "test.sqlite");
    const probe = join(tempDir, "probe.ts");
    const ingestTrackModule = join(process.cwd(), "src/services/ingestTrack.ts");
    const dbModule = join(process.cwd(), "src/server/db/index.ts");
    const schemaModule = join(process.cwd(), "src/server/db/schema.ts");
    await writeFile(
      probe,
      `import { sql } from "drizzle-orm";
const { db } = await import(${JSON.stringify(dbModule)});
const { tracks } = await import(${JSON.stringify(schemaModule)});
const { ingestTrack } = await import(${JSON.stringify(ingestTrackModule)});
await db.run(sql\`CREATE TABLE IF NOT EXISTS tracks_table (
  id text PRIMARY KEY NOT NULL,
  youtube_id text NOT NULL UNIQUE,
  musicbrainz_recording_id text UNIQUE,
  release_group_id text,
  title text NOT NULL,
  first_release_date integer NOT NULL,
  length integer NOT NULL,
  file_path text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
)\`);
await db.insert(tracks).values({
  id: "track-owner",
  youtube_id: "abcdefghijk",
  musicbrainz_recording_id: "rec-dup",
  title: "Song",
  first_release_date: new Date("2020-01-01"),
  length: 1000,
  file_path: "audio/Song.m4a",
});
globalThis.fetch = (async () => {
  throw new Error("fetch should not be called");
}) as unknown as typeof fetch;
await ingestTrack("https://youtube.com/watch?v=abcdefghijk", "job-youtube-only");
`,
    );
    const child = Bun.spawn(["bun", probe], {
      cwd: process.cwd(),
      env: { ...process.env, DB_FILE_NAME: databasePath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const all = await records();
    const forJob = all.filter((r) => r.jobId === "job-youtube-only");

    expect(await Bun.file(ytDlpMarker).exists()).toBe(false);
    expect(forJob.filter((r) => r.event === "external_call_finished")).toHaveLength(0);
    expect(forJob.filter((r) => r.event === "musicbrainz_query_sent")).toHaveLength(0);

    const skipped = forJob.filter((r) => r.event === "ingest_skipped_duplicate");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      level: "info",
      jobId: "job-youtube-only",
      youtubeId: "abcdefghijk",
      stage: "youtube_id_check",
      matchCount: 1,
      matchedBy: ["youtube_id"],
      matchedTrackIds: ["track-owner"],
    });
    expect(forJob.some((r) => r.event === "ingest_completed")).toBe(false);
  });
});
