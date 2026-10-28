import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/utils/runCommand";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-groups-"));
});

afterEach(async () => {
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

// Signals are delivered asynchronously, so give the kernel a moment.
async function eventuallyDead(pids: number[]) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const alive = await Promise.all(pids.map(isAlive));
    if (alive.every((live) => !live)) return true;
    await Bun.sleep(40);
  }
  return false;
}

async function readPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.trim()) return Number(text.trim());
    await Bun.sleep(20);
  }
  throw new Error(`no pid written to ${path}`);
}

// A fake tool that starts a background sleep (a grandchild of the runCommand child)
// and waits on it. It records its own pid and the sleep's pid.
async function fakeToolWithGrandchild() {
  const script = join(tempDir, "fake-tool.sh");
  await writeFile(
    script,
    '#!/bin/sh\necho $$ > "$1.self"\nsleep 30 &\necho $! > "$1.child"\nwait\n',
  );
  await chmod(script, 0o755);
  return script;
}

describe("runCommand process groups", () => {
  test("a timeout kills the command and the process it started", async () => {
    const script = await fakeToolWithGrandchild();
    const marker = join(tempDir, "run");
    const started = performance.now();
    const error = await runCommand([script, marker], {
      timeoutMs: 1500,
      label: "fake",
    }).catch((e) => e);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(error).toMatchObject({ errorKind: "timeout" });

    const pids = [
      await readPid(`${marker}.self`),
      await readPid(`${marker}.child`),
    ];
    expect(await eventuallyDead(pids)).toBe(true);
  });

  test("a normal run still returns its output and exit code", async () => {
    expect(
      await runCommand(["sh", "-c", "echo out; echo err >&2; exit 0"], {
        timeoutMs: 5000,
        label: "sh",
      }),
    ).toBe("out\n");
    const error = await runCommand(["sh", "-c", "exit 7"], {
      timeoutMs: 5000,
      label: "sh",
    }).catch((e) => e);
    expect(error).toMatchObject({ exitCode: 7 });
    expect(error.errorKind).toBeUndefined();
  });

  test("exiting the process kills commands that are still running", async () => {
    const script = await fakeToolWithGrandchild();
    const marker = join(tempDir, "exit-run");
    const driver = join(tempDir, "driver.ts");
    const runnerPath = join(process.cwd(), "src/utils/runCommand.ts");
    // The driver starts a command without waiting for it, then exits as the worker
    // does on a stop signal.
    await writeFile(
      driver,
      `import { runCommand } from ${JSON.stringify(runnerPath)};
runCommand([${JSON.stringify(script)}, ${JSON.stringify(marker)}], { timeoutMs: 60000, label: "fake" }).catch(() => {});
await Bun.sleep(100);
process.exit(0);
`,
    );
    const exited = Bun.spawn(["bun", driver], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await exited.exited;

    const pids = [
      await readPid(`${marker}.self`),
      await readPid(`${marker}.child`),
    ];
    expect(await eventuallyDead(pids)).toBe(true);
  });
});
