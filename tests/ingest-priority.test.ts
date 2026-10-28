import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lowerWorkerPriority,
  WORKER_NICE,
} from "../src/workers/ingestTrack/priority";

let tempDir: string;

const todayLog = () =>
  join(
    process.env.LOG_DIR!,
    `ingest-${new Date().toLocaleDateString("en-CA")}.jsonl`,
  );

async function events() {
  try {
    return (await readFile(todayLog(), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).event as string);
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-priority-log-"));
  process.env.LOG_DIR = tempDir;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("lowerWorkerPriority", () => {
  test("sets nice and idle I/O on the worker when both are available", async () => {
    const niceValues: number[] = [];
    const ionice: number[] = [];
    await lowerWorkerPriority({
      nice: (value) => niceValues.push(value),
      readNice: () => WORKER_NICE,
      ioniceBinary: "/usr/bin/ionice",
      runIonice: async (pid) => {
        ionice.push(pid);
        return { exitCode: 0, stderr: "" };
      },
    });
    expect(niceValues).toEqual([10]);
    expect(ionice).toEqual([process.pid]);
    expect(await events()).toEqual([
      "worker_priority_set",
      "worker_ionice_set",
    ]);
  });

  test("a refused nice call is logged and ionice is still tried", async () => {
    let ioniceCalled = false;
    await lowerWorkerPriority({
      nice: () => {
        throw new Error("EACCES");
      },
      ioniceBinary: "/usr/bin/ionice",
      runIonice: async () => {
        ioniceCalled = true;
        return { exitCode: 1, stderr: "ionice: failed to set priority" };
      },
    });
    expect(ioniceCalled).toBe(true);
    expect(await events()).toEqual([
      "worker_priority_failed",
      "worker_ionice_failed",
    ]);
  });

  test("a missing ionice binary is logged, not treated as an error", async () => {
    await lowerWorkerPriority({
      nice: () => {},
      readNice: () => WORKER_NICE,
      ioniceBinary: null,
    });
    expect(await events()).toEqual([
      "worker_priority_set",
      "worker_ionice_unavailable",
    ]);
  });
});
