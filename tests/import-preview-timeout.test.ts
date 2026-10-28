import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

let tempDir: string;
let server: Bun.Subprocess | undefined;
let base: string;
const originalPath = process.env.PATH;

// yt-dlp is replaced by a script that never finishes, so every preview call stalls.
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-preview-timeout-"));
  const bin = join(tempDir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "yt-dlp"), "#!/bin/sh\nexec sleep 30\n");
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
      DB_FILE_NAME: databasePath,
      BIND_HOST: "127.0.0.1",
      BIND_PORT: String(port),
      DEMO_MODE: "false",
      LOG_DIR: tempDir,
      YT_DLP_PLAYLIST_TIMEOUT_MS: "200",
      YT_DLP_METADATA_TIMEOUT_MS: "200",
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

function preview(url: string) {
  return fetch(`${base}/import/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

describe("POST /import/preview time limits", () => {
  test("a stalled playlist lookup answers 504 with a message", async () => {
    const res = await preview("https://www.youtube.com/playlist?list=PL1234");
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(typeof body.message).toBe("string");
    expect(body.message).toContain("timed out");
  });

  test("a stalled single-video lookup answers 504 instead of a blank title", async () => {
    const res = await preview("https://youtu.be/abcdefghijk");
    expect(res.status).toBe(504);
    expect((await res.json()).message).toContain("timed out");
  });
});
