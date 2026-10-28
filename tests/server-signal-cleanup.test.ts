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
import { Database } from "bun:sqlite";

let tempDir: string;
let server: Bun.Subprocess | undefined;
let base: string;
const originalPath = process.env.PATH;

// A fake yt-dlp that starts a background sleep (a grandchild) and records both pids.
// The preview call stays in flight until the server is stopped.
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-server-signal-"));
  const bin = join(tempDir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "yt-dlp"),
    '#!/bin/sh\necho $$ > "$FAKE_PIDS.self"\nsleep 30 &\necho $! > "$FAKE_PIDS.child"\nwait\n',
  );
  await chmod(join(bin, "yt-dlp"), 0o755);

  const databasePath = join(tempDir, "test.sqlite");
  const setup = new Database(databasePath);
  setup.exec(
    await Bun.file(
      new URL("./fixtures/playlist-schema.sql", import.meta.url),
    ).text(),
  );
  setup.close();

  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  server = Bun.spawn(["bun", "src/server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${bin}:${originalPath}`,
      FAKE_PIDS: join(tempDir, "run"),
      DB_FILE_NAME: databasePath,
      BIND_HOST: "127.0.0.1",
      BIND_PORT: String(port),
      DEMO_MODE: "false",
      LOG_DIR: tempDir,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(`${base}/`);
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await Bun.sleep(100);
    }
  }
});

afterEach(async () => {
  server?.kill();
  server = undefined;
  process.env.PATH = originalPath;
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

describe("server stop signals", () => {
  test("SIGINT kills a running yt-dlp and its grandchild, then exits with 130", async () => {
    // The request stays open while yt-dlp runs. Its error is expected once the server dies.
    const preview = fetch(`${base}/import/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/playlist?list=PL1234",
      }),
    }).catch((error) => error);

    const marker = join(tempDir, "run");
    const pids = [
      await readPid(`${marker}.self`),
      await readPid(`${marker}.child`),
    ];
    expect(await Promise.all(pids.map(isAlive))).toEqual([true, true]);

    server!.kill("SIGINT");
    expect(await server!.exited).toBe(128 + 2);
    await preview;

    for (let attempt = 0; attempt < 50; attempt++) {
      const alive = await Promise.all(pids.map(isAlive));
      if (alive.every((live) => !live)) return;
      await Bun.sleep(40);
    }
    throw new Error(`commands still running after SIGINT: ${pids.join(", ")}`);
  });
});
