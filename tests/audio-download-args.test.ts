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

async function fakeYtDlp(script: string) {
  const bin = join(tempDir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "yt-dlp"), `#!/bin/sh\n${script}\n`);
  await chmod(join(bin, "yt-dlp"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-audio-args-"));
  process.env.LOG_DIR = tempDir;
  process.env.PATH = originalPath;
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  process.env.PATH = originalPath;
});

describe("opusFilePath", () => {
  test("stores every download as .opus, replacing any other extension", async () => {
    const { opusFilePath } = await import("../src/utils/fetchAudio");
    expect(opusFilePath("audio/Song.opus")).toBe("audio/Song.opus");
    expect(opusFilePath("audio/Song.m4a")).toBe("audio/Song.opus");
    expect(opusFilePath("audio/Mr._Brightside")).toBe(
      "audio/Mr._Brightside.opus",
    );
    expect(opusFilePath("audio/Vol.2")).toBe("audio/Vol.2.opus");
  });

  test("only strips the extension from the last path segment", async () => {
    const { opusFilePath } = await import("../src/utils/fetchAudio");
    expect(opusFilePath("audio/v1.2/Song")).toBe("audio/v1.2/Song.opus");
  });
});

describe("ytDlpDownloadArgs", () => {
  test("selects the Opus stream, extracts to Opus, and skips thumbnail embedding", async () => {
    const { ytDlpDownloadArgs } = await import("../src/utils/fetchAudio");
    const args = ytDlpDownloadArgs(
      "https://youtube.com/watch?v=abcdefghijk",
      "audio/Song.opus",
    );

    expect(args[0]).toBe("yt-dlp");
    expect(args[args.indexOf("-f") + 1]).toBe(
      "bestaudio[acodec=opus]/bestaudio",
    );
    expect(args[args.indexOf("--audio-format") + 1]).toBe("opus");
    expect(args).toContain("--extract-audio");
    expect(args).toContain("--embed-metadata");
    expect(args).not.toContain("--embed-thumbnail");
    expect(args.join(" ")).not.toContain("movflags");
    expect(args.join(" ")).not.toContain("m4a");
    expect(args.at(-1)).toBe("https://youtube.com/watch?v=abcdefghijk");
  });

  test("the output template pins the extension to .opus", async () => {
    const { ytDlpDownloadArgs } = await import("../src/utils/fetchAudio");
    const args = ytDlpDownloadArgs("u", "audio/Song.m4a");
    expect(args[args.indexOf("-o") + 1]).toBe("audio/Song.%(ext)s");
  });

  test("doubles percent signs so yt-dlp does not read them as template syntax", async () => {
    const { ytDlpDownloadArgs } = await import("../src/utils/fetchAudio");
    const args = ytDlpDownloadArgs("u", "audio/100%_Pure.opus");
    expect(args[args.indexOf("-o") + 1]).toBe("audio/100%%_Pure.%(ext)s");
  });
});

describe("downloadWithRetry", () => {
  test("runs yt-dlp with exactly the computed arguments and logs the .opus path", async () => {
    const argv = join(tempDir, "argv.txt");
    await fakeYtDlp(`printf '%s\\n' "$@" > '${argv}'`);
    const { downloadWithRetry, ytDlpDownloadArgs } =
      await import("../src/utils/fetchAudio");
    const url = "https://youtube.com/watch?v=abcdefghijk";
    const filePath = join(tempDir, "audio", "Song.opus");

    await expect(
      downloadWithRetry(url, filePath, {
        jobId: "job-args",
        youtubeId: "yt-args",
      }),
    ).resolves.toBe(1);

    const received = (await readFile(argv, "utf8"))
      .split("\n")
      .filter((line) => line !== "");
    expect(received).toEqual(ytDlpDownloadArgs(url, filePath).slice(1));
    const template = received[received.indexOf("-o") + 1];
    expect(template).toBe(join(tempDir, "audio", "Song.%(ext)s"));
  });
});
