import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logWorkerLifecycle } from "../src/workers/ingestTrack/lifecycle";

let tempDir: string;
let listenersBefore: Map<string | symbol, Function[]>;

const snapshotListeners = () =>
  new Map(process.eventNames().map((name) => [name, [...process.listeners(name)]]));

// Drops the listeners a test added so later tests see a clean process.
function removeAddedListeners() {
  for (const name of process.eventNames()) {
    const before = listenersBefore.get(name) ?? [];
    for (const listener of process.listeners(name)) {
      if (!before.includes(listener)) process.removeListener(name, listener as any);
    }
  }
}

// A fake exit that records its codes and lets a test await the first one.
function fakeExit() {
  const codes: number[] = [];
  let notify!: () => void;
  const exited = new Promise<void>((resolve) => (notify = resolve));
  const exit = (code: number) => {
    codes.push(code);
    notify();
  };
  return { exit, exited, codes };
}

const todayLog = () =>
  join(process.env.LOG_DIR!, `ingest-${new Date().toLocaleDateString("en-CA")}.jsonl`);
async function records() {
  return (await readFile(todayLog(), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-lifecycle-log-"));
  process.env.LOG_DIR = tempDir;
  listenersBefore = snapshotListeners();
  spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  removeAddedListeners();
  delete process.env.LOG_DIR;
});

describe("worker lifecycle logging", () => {
  test("logs worker_started with the pid and does not exit", async () => {
    const { exit, codes } = fakeExit();
    await logWorkerLifecycle(exit);

    const started = (await records()).find((r) => r.event === "worker_started");
    expect(started).toMatchObject({ level: "info", pid: process.pid });
    expect(codes).toEqual([]);
  });

  test("logs worker_stopping with the signal and exits as the signal would", async () => {
    const { exit, exited, codes } = fakeExit();
    await logWorkerLifecycle(exit);

    process.emit("SIGTERM", "SIGTERM");
    await exited;

    const stopping = (await records()).find((r) => r.event === "worker_stopping");
    expect(stopping).toMatchObject({ level: "info", signal: "SIGTERM" });
    expect(codes).toEqual([128 + 15]);
  });

  test("logs an uncaught exception to the file, prints it, and exits 1", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const { exit, exited, codes } = fakeExit();
    await logWorkerLifecycle(exit);

    const boom = new Error("boom");
    process.emit("uncaughtException", boom, "uncaughtException");
    await exited;

    expect(codes).toEqual([1]);
    expect(errorSpy).toHaveBeenCalledWith(boom);
    const crash = (await records()).find((r) => r.event === "uncaught_exception");
    expect(crash).toMatchObject({ level: "error", error: { name: "Error", message: "boom" } });
  });

  test("logs an unhandled rejection to the file, prints it, and exits 1", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const { exit, exited, codes } = fakeExit();
    await logWorkerLifecycle(exit);

    const reason = new Error("rejected");
    process.emit("unhandledRejection", reason, Promise.resolve());
    await exited;

    expect(codes).toEqual([1]);
    expect(errorSpy).toHaveBeenCalledWith(reason);
    const rejection = (await records()).find((r) => r.event === "unhandled_rejection");
    expect(rejection).toMatchObject({ level: "error", error: { message: "rejected" } });
  });
});
