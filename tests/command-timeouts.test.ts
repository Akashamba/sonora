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
import {
  CommandError,
  commandTimeoutMs,
  runCommand,
} from "../src/utils/runCommand";
import { downloadWithRetry } from "../src/utils/fetchAudio";

const originalPath = process.env.PATH;
let tempDir: string;

const todayLog = () =>
  join(
    process.env.LOG_DIR!,
    `ingest-${new Date().toLocaleDateString("en-CA")}.jsonl`,
  );
async function records() {
  return (await readFile(todayLog(), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-timeouts-"));
  process.env.LOG_DIR = tempDir;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.YT_DLP_DOWNLOAD_TIMEOUT_MS;
  delete process.env.YT_DLP_METADATA_TIMEOUT_MS;
  delete process.env.FFPROBE_TIMEOUT_MS;
  await rm(tempDir, { recursive: true, force: true });
});

describe("runCommand", () => {
  test("returns stdout of a command that finishes in time", async () => {
    expect(
      await runCommand(["echo", "hello"], { timeoutMs: 5000, label: "echo" }),
    ).toBe("hello\n");
  });

  test("finds the command on a PATH that changed after startup", async () => {
    const binDir = join(tempDir, "bin");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "sonora-fake-tool"),
      "#!/bin/sh\necho from-fake\n",
    );
    await chmod(join(binDir, "sonora-fake-tool"), 0o755);
    process.env.PATH = `${binDir}:${originalPath}`;

    expect(
      await runCommand(["sonora-fake-tool"], {
        timeoutMs: 5000,
        label: "fake",
      }),
    ).toBe("from-fake\n");
  });

  test("a non-zero exit rejects with the exit code and stderr", async () => {
    const error = await runCommand(["sh", "-c", "echo oops >&2; exit 3"], {
      timeoutMs: 5000,
      label: "sh",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ exitCode: 3, stderr: "oops\n" });
    expect(error.errorKind).toBeUndefined();
  });

  test("a stalled command is killed at the limit and rejects as a timeout", async () => {
    const started = performance.now();
    const error = await runCommand(["sleep", "30"], {
      timeoutMs: 100,
      label: "sleep",
    }).catch((e) => e);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ errorKind: "timeout" });
    expect(error.message).toContain("timed out after 100ms");
  });

  test("a timeout still returns when a child of the command keeps the pipes open", async () => {
    const started = performance.now();
    const error = await runCommand(["sh", "-c", "sleep 3 & wait"], {
      timeoutMs: 100,
      label: "sh",
    }).catch((e) => e);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(error).toMatchObject({ errorKind: "timeout" });
  });
});

describe("command timeouts", () => {
  test("default limits and environment overrides", () => {
    expect(commandTimeoutMs("ytDlpMetadata")).toBe(60_000);
    expect(commandTimeoutMs("ytDlpDownload")).toBe(15 * 60_000);
    expect(commandTimeoutMs("ffprobe")).toBe(30_000);
    process.env.YT_DLP_METADATA_TIMEOUT_MS = "2500";
    expect(commandTimeoutMs("ytDlpMetadata")).toBe(2500);
    process.env.FFPROBE_TIMEOUT_MS = "bogus";
    expect(commandTimeoutMs("ffprobe")).toBe(30_000);
  });
});

describe("download timeouts", () => {
  test("a stalled yt-dlp download is retried, timed out, logged, and rethrown", async () => {
    // A fake yt-dlp that never finishes, on a PATH of its own.
    const binDir = join(tempDir, "bin");
    await mkdir(binDir);
    await writeFile(join(binDir, "yt-dlp"), "#!/bin/sh\nsleep 30\n");
    await chmod(join(binDir, "yt-dlp"), 0o755);
    process.env.PATH = `${binDir}:${originalPath}`;
    process.env.YT_DLP_DOWNLOAD_TIMEOUT_MS = "100";

    const error = await downloadWithRetry(
      "https://www.youtube.com/watch?v=abcdefghijk",
      join(tempDir, "song.m4a"),
      { jobId: "job-1", youtubeId: "abcdefghijk" },
      2,
    ).catch((e) => e);

    expect(error).toMatchObject({ errorKind: "timeout" });
    const lines = await records();
    const finished = lines.filter(
      (r) =>
        r.event === "external_call_finished" && r.service === "yt_dlp_download",
    );
    expect(finished.length).toBe(2);
    expect(finished[0]).toMatchObject({
      outcome: "error",
      errorKind: "timeout",
    });
    expect(
      lines.filter((r) => r.event === "audio_download_attempt_failed").length,
    ).toBe(2);
  });
});
