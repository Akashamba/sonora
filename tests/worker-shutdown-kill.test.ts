import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, killAllRunningCommands } from "../src/utils/runCommand";
import {
  createOwnedJobs,
  stopWorker,
  type StopState,
} from "../src/workers/ingestTrack/shutdown";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-worker-kill-"));
});

afterEach(async () => {
  killAllRunningCommands();
  await rm(tempDir, { recursive: true, force: true });
});

// A process that is dead but not yet reaped (a zombie) counts as dead.
async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  return stat === null ? true : !/\) Z /.test(stat);
}

async function readPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.trim()) return Number(text.trim());
    await Bun.sleep(20);
  }
  throw new Error(`no pid written to ${path}`);
}

describe("worker stop after the grace period", () => {
  test("requeues the unfinished job, kills its command, and returns at the grace limit", async () => {
    // A fake tool that outlives the grace period, with a grandchild sleep.
    const script = join(tempDir, "fake-tool.sh");
    await writeFile(
      script,
      '#!/bin/sh\necho $$ > "$1.self"\nsleep 30 &\necho $! > "$1.child"\nwait\n',
    );
    await chmod(script, 0o755);
    const marker = join(tempDir, "run");
    const command = runCommand([script, marker], {
      timeoutMs: 15 * 60_000,
      label: "fake yt-dlp",
    }).catch((error) => error);

    const order: string[] = [];
    const owned = createOwnedJobs();
    owned.add(["job-1"]);
    const state: StopState = { requested: false, pool: new Promise(() => {}) };
    const started = performance.now();
    await stopWorker({
      state,
      graceMs: 100,
      owned,
      requeue: async (ids) => {
        order.push(`requeue ${ids.join(",")}`);
      },
      killRunning: () => {
        order.push("kill");
        killAllRunningCommands();
      },
    });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(order).toEqual(["requeue job-1", "kill"]);

    // The command ends once its group is killed, long before its 15 minute limit.
    const error = await command;
    expect(error).toMatchObject({ exitCode: expect.any(Number) });

    const pids = [
      await readPid(`${marker}.self`),
      await readPid(`${marker}.child`),
    ];
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!(await Promise.all(pids.map(isAlive))).some(Boolean)) return;
      await Bun.sleep(40);
    }
    throw new Error("command still running after the worker stopped");
  });
});
