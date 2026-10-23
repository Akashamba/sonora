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
  tempDir = await mkdtemp(join(tmpdir(), "sonora-download-file-log-"));
  process.env.LOG_DIR = tempDir;
  process.env.PATH = originalPath;
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  process.env.PATH = originalPath;
});

describe("audio download success", () => {
  test("a download that recovered on retry logs audio_download_succeeded with its attempt count", async () => {
    const counter = join(tempDir, "count");
    await fakeYtDlp(`if [ ! -f '${counter}' ]; then touch '${counter}'; echo 'ERROR: Failed to resolve host' >&2; exit 1; fi\nexit 0`);
    const { downloadWithRetry } = await import("../src/utils/fetchAudio");
    const filePath = join(tempDir, "recovered.opus");

    await expect(
      downloadWithRetry("https://youtube.com/watch?v=abcdefghijk", filePath, { jobId: "job-retry", youtubeId: "yt-retry" }, 3),
    ).resolves.toBe(2);

    const success = (await records()).filter((r) => r.event === "audio_download_succeeded");
    expect(success).toHaveLength(1);
    expect(success[0]).toMatchObject({
      level: "info",
      jobId: "job-retry",
      youtubeId: "yt-retry",
      stage: "audio_download",
      filePath,
      downloadAttempts: 2,
    });
  });

  test("a first-attempt download logs downloadAttempts 1", async () => {
    await fakeYtDlp("exit 0");
    const { downloadWithRetry } = await import("../src/utils/fetchAudio");
    const filePath = join(tempDir, "first.opus");

    await expect(
      downloadWithRetry("https://youtube.com/watch?v=abcdefghijk", filePath, { jobId: "job-first", youtubeId: "yt-first" }),
    ).resolves.toBe(1);

    const success = (await records()).filter((r) => r.event === "audio_download_succeeded" && r.jobId === "job-first");
    expect(success).toHaveLength(1);
    expect(success[0]).toMatchObject({ downloadAttempts: 1, filePath, youtubeId: "yt-first" });
  });
});

describe("audio path state before download", () => {
  test("reports a free path, then a path already owned by another track on disk", async () => {
    // Runs in a child process with its own DB_FILE_NAME. The DB module is a singleton
    // per process, and Bun loads .env (the real tracks.sqlite) at startup, so this
    // test must not load src/server/db in the test process.
    const databasePath = join(tempDir, "test.sqlite");
    const filePath = join(tempDir, "audio", "Same_Title.opus");
    const probe = join(tempDir, "probe.ts");
    const ingestTrackModule = join(process.cwd(), "src/services/ingestTrack.ts");
    const dbModule = join(process.cwd(), "src/server/db/index.ts");
    const schemaModule = join(process.cwd(), "src/server/db/schema.ts");
    await writeFile(
      probe,
      `import { sql } from "drizzle-orm";
const { db } = await import(${JSON.stringify(dbModule)});
const { tracks } = await import(${JSON.stringify(schemaModule)});
const { logAudioPathState } = await import(${JSON.stringify(ingestTrackModule)});
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
const context = { jobId: "job-path", youtubeId: "yt-new" };
await logAudioPathState(${JSON.stringify(filePath)}, context);
await Bun.write(${JSON.stringify(filePath)}, "audio");
await db.insert(tracks).values({
  youtube_id: "yt-owner",
  title: "Same Title",
  first_release_date: new Date("2020-01-01"),
  length: 1000,
  file_path: ${JSON.stringify(filePath)},
});
await logAudioPathState(${JSON.stringify(filePath)}, context);
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

    const checked = (await records()).filter((r) => r.event === "audio_path_checked" && r.jobId === "job-path");
    expect(checked).toHaveLength(2);
    expect(checked[0]).toMatchObject({
      youtubeId: "yt-new",
      filePath,
      fileExisted: false,
      ownerCount: 0,
      ownerYoutubeIds: [],
      ownerTrackIds: [],
    });
    expect(checked[1]).toMatchObject({
      fileExisted: true,
      ownerCount: 1,
      ownerYoutubeIds: ["yt-owner"],
    });
    expect(checked[1].ownerTrackIds).toHaveLength(1);
  });
});
