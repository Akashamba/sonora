import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

const originalPath = process.env.PATH;
let tempDir: string;
let callLog: string;

// Fake yt-dlp and ffprobe. Each call appends its arguments, one per line, then a
// separator line, so a test can check the exact argv that reached the tool.
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-argv-"));
  process.env.LOG_DIR = tempDir;
  const bin = join(tempDir, "bin");
  await mkdir(bin, { recursive: true });
  callLog = join(tempDir, "calls.log");
  const record = `printf '%s\\n' "$@" >> "${callLog}"\necho "---" >> "${callLog}"\n`;
  await writeFile(
    join(bin, "yt-dlp"),
    `#!/bin/sh\n${record}echo "https://youtu.be/abcdefghijk"\necho '{"title":"Artist - Song"}'\n`,
  );
  await writeFile(join(bin, "ffprobe"), `#!/bin/sh\n${record}echo 1.5\n`);
  await chmod(join(bin, "yt-dlp"), 0o755);
  await chmod(join(bin, "ffprobe"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await rm(tempDir, { recursive: true, force: true });
});

// The argv of every recorded call, in order.
async function calls(): Promise<string[][]> {
  const text = await readFile(callLog, "utf8");
  return text
    .split("---\n")
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.trimEnd().split("\n"));
}

// The argument right before `value` must be `--`, so `value` cannot be read as an option.
function expectEndOfOptionsBefore(argv: string[], value: string) {
  const index = argv.indexOf(value);
  expect(index).toBeGreaterThan(0);
  expect(argv[index - 1]).toBe("--");
}

describe("yt-dlp and ffprobe end option parsing before user input", () => {
  test("playlist expansion", async () => {
    const { getAllUrlsFromPlaylist } =
      await import("../src/utils/metadata-utils");
    const url = "https://www.youtube.com/playlist?list=PL1";
    await getAllUrlsFromPlaylist(url);
    const argv = (await calls())[0] ?? [];
    expect(argv[0]).toBe("--flat-playlist");
    expectEndOfOptionsBefore(argv, url);
  });

  test("metadata lookup", async () => {
    const { fetchYtMetadata } = await import("../src/utils/metadata-utils");
    const url = "https://youtu.be/abcdefghijk";
    await fetchYtMetadata(url).catch(() => {});
    const argv = (await calls())[0] ?? [];
    expect(argv[0]).toBe("--dump-json");
    expectEndOfOptionsBefore(argv, url);
  });

  test("audio download", async () => {
    const { downloadWithRetry } = await import("../src/utils/fetchAudio");
    const url = "https://youtu.be/abcdefghijk";
    await downloadWithRetry(
      url,
      join(tempDir, "song.m4a"),
      {
        jobId: "job-1",
        youtubeId: "abcdefghijk",
      },
      1,
    );
    const argv = (await calls())[0] ?? [];
    expectEndOfOptionsBefore(argv, url);
  });

  test("audio length probe", async () => {
    const { getAudioLengthMs } = await import("../src/utils/metadata-utils");
    const path = join(tempDir, "-leading-dash.opus");
    expect(await getAudioLengthMs(path)).toBe(1500);
    const argv = (await calls())[0] ?? [];
    expectEndOfOptionsBefore(argv, path);
  });
});
