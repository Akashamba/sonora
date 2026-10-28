import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Database } from "bun:sqlite";

// Runs the real script in a child process against a temp DB and temp files.
// The fake yt-dlp copies a generated Opus file to the requested output path.
const repoRoot = process.cwd();
const script = join(repoRoot, "src/scripts/convert-library-to-opus.ts");
const originalPath = process.env.PATH;
let tempDir: string;
let dbPath: string;
let audioDir: string;
let invokedLog: string;

async function makeAudio(
  path: string,
  seconds: number,
  codec: "libopus" | "aac",
) {
  const ext = codec === "libopus" ? "opus" : "m4a";
  const out = path.replace(/\.[^.]+$/, `.${ext}`);
  await $`ffmpeg -v error -f lavfi -i sine=frequency=440:duration=${seconds} -c:a ${codec} -y ${out}`;
  return out;
}

async function probeCodec(path: string) {
  return (
    await $`ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 ${path}`.text()
  ).trim();
}

function insertTrack(id: string, filePath: string) {
  const db = new Database(dbPath);
  db.query(
    "INSERT INTO tracks_table (id, youtube_id, title, first_release_date, length, file_path, created_at, updated_at) VALUES (?, ?, ?, 0, 2000, ?, 0, 0)",
  ).run(id, `yt-${id}`, `Song ${id}`, filePath);
  db.close();
}

function filePathOf(id: string) {
  const db = new Database(dbPath);
  const row = db
    .query("SELECT file_path FROM tracks_table WHERE id = ?")
    .get(id) as { file_path: string };
  db.close();
  return row.file_path;
}

async function runScript(extra: string[] = []) {
  const bin = join(tempDir, "bin");
  const proc = Bun.spawn([process.execPath, "run", script, ...extra], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DB_FILE_NAME: dbPath,
      LOG_DIR: tempDir,
      PATH: `${bin}:${originalPath}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, output: stdout + stderr };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-opus-convert-"));
  dbPath = join(tempDir, "test.sqlite");
  audioDir = join(tempDir, "audio");
  invokedLog = join(tempDir, "invoked.log");
  await mkdir(audioDir, { recursive: true });

  const fixture = await makeAudio(join(tempDir, "fixture.opus"), 2, "libopus");
  const bin = join(tempDir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "yt-dlp"),
    [
      "#!/bin/sh",
      `echo "$@" >> '${invokedLog}'`,
      'while [ "$1" != "-o" ]; do shift; done',
      `cp '${fixture}' "$(printf '%s' "$2" | sed 's/%(ext)s/opus/')"`,
      "",
    ].join("\n"),
  );
  await chmod(join(bin, "yt-dlp"), 0o755);

  const db = new Database(dbPath);
  db.run(`CREATE TABLE tracks_table (
    id text PRIMARY KEY NOT NULL,
    youtube_id text NOT NULL UNIQUE,
    musicbrainz_recording_id text UNIQUE,
    release_group_id text,
    title text NOT NULL,
    first_release_date integer NOT NULL,
    length integer NOT NULL,
    file_path text NOT NULL, disc_number integer, track_number integer,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  )`);
  db.close();

  // a: old m4a, converted. b: already Opus, never selected.
  // c: old m4a plus a finished .opus from an interrupted run, adopted without a download.
  // d: old m4a is 10s but YouTube gives 2s, so it must fail and keep its file.
  await makeAudio(join(audioDir, "Song_a.m4a"), 2, "aac");
  await writeFile(join(audioDir, "Song_b.opus"), await readFile(fixture));
  await makeAudio(join(audioDir, "Song_c.m4a"), 2, "aac");
  await writeFile(join(audioDir, "Song_c.opus"), await readFile(fixture));
  await makeAudio(join(audioDir, "Song_d.m4a"), 10, "aac");

  insertTrack("a", join(audioDir, "Song_a.m4a"));
  insertTrack("b", join(audioDir, "Song_b.opus"));
  insertTrack("c", join(audioDir, "Song_c.m4a"));
  insertTrack("d", join(audioDir, "Song_d.m4a"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  process.env.PATH = originalPath;
});

describe("convert-library-to-opus", () => {
  test("dry run lists what would change and touches nothing", async () => {
    const { code, output } = await runScript();

    expect(code).toBe(0);
    expect(output).toContain("3 track(s) not stored as .opus (dry run");
    expect(output).toContain("would convert: Song a");
    expect(output).not.toContain("Song b");
    expect(output).toContain("would convert 3, skipped 0, failed 0");
    expect(filePathOf("a")).toBe(join(audioDir, "Song_a.m4a"));
    expect(existsSync(join(audioDir, "Song_a.m4a"))).toBe(true);
    expect(existsSync(invokedLog)).toBe(false);
  });

  test("--apply downloads, verifies, updates the DB, then removes the old file", async () => {
    const { code, output } = await runScript(["--apply"]);

    expect(code).toBe(1); // row d fails verification
    expect(output).toContain("failed: Song d");
    expect(output).toContain("converted 2, skipped 0, failed 1");

    expect(filePathOf("a")).toBe(join(audioDir, "Song_a.opus"));
    expect(filePathOf("c")).toBe(join(audioDir, "Song_c.opus"));
    expect(filePathOf("b")).toBe(join(audioDir, "Song_b.opus"));
    expect(filePathOf("d")).toBe(join(audioDir, "Song_d.m4a"));

    expect(await probeCodec(join(audioDir, "Song_a.opus"))).toBe("opus");
    expect(existsSync(join(audioDir, "Song_a.m4a"))).toBe(false);
    expect(existsSync(join(audioDir, "Song_c.m4a"))).toBe(false);

    // d keeps its old file and leaves no hidden temp file behind.
    expect(existsSync(join(audioDir, "Song_d.m4a"))).toBe(true);
    expect(existsSync(join(audioDir, "Song_d.opus"))).toBe(false);
    expect(existsSync(join(audioDir, ".convert-d.opus"))).toBe(false);
  });

  test("only downloads tracks that were not already adopted, and never re-selects converted rows", async () => {
    await runScript(["--apply"]);
    const invoked = (await readFile(invokedLog, "utf8")).trim().split("\n");
    expect(invoked).toHaveLength(2); // a and d, not c (adopted) or b (already opus)
    expect(invoked.some((line) => line.includes("watch?v=yt-a"))).toBe(true);
    expect(invoked.some((line) => line.includes("watch?v=yt-c"))).toBe(false);

    const rerun = await runScript(["--apply"]);
    expect(rerun.output).toContain("1 track(s) not stored as .opus");
    expect(rerun.output).toContain("converted 0, skipped 0, failed 1");
  });

  test("keeps the old file while another row still points at it", async () => {
    // Track f points at c's old m4a too. Once c is converted, the file is still
    // needed by f, so it must stay. Run one at a time so the row order is fixed.
    insertTrack("f", join(audioDir, "Song_c.m4a"));

    const { output } = await runScript(["--apply", "--concurrency", "1"]);
    expect(output).toContain(
      `kept ${join(audioDir, "Song_c.m4a")}: track f still points at it`,
    );
    expect(filePathOf("c")).toBe(join(audioDir, "Song_c.opus"));
    expect(existsSync(join(audioDir, "Song_c.m4a"))).toBe(true);
    expect(filePathOf("f")).toBe(join(audioDir, "Song_c.m4a"));
  });

  test("skips a row whose target path belongs to another track", async () => {
    // Track e already owns a's target path, so a must be skipped, not overwritten.
    insertTrack("e", join(audioDir, "Song_a.opus"));

    const { code, output } = await runScript(["--apply"]);
    expect(code).toBe(1); // d still fails verification
    expect(output).toContain(
      `SKIP, ${join(audioDir, "Song_a.opus")} belongs to track e`,
    );
    expect(filePathOf("a")).toBe(join(audioDir, "Song_a.m4a"));
    expect(existsSync(join(audioDir, "Song_a.m4a"))).toBe(true);
    expect(existsSync(invokedLog)).toBe(true);
    expect((await readFile(invokedLog, "utf8")).includes("watch?v=yt-a")).toBe(
      false,
    );
  });
});
