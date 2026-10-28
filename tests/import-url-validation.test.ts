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
let databasePath: string;
let callLog: string;

// yt-dlp is replaced by a script that records its arguments and prints an empty
// playlist. Any call that reaches it shows up in the log.
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-import-url-"));
  const bin = join(tempDir, "bin");
  await mkdir(bin, { recursive: true });
  callLog = join(tempDir, "yt-dlp-calls.log");
  await writeFile(
    join(bin, "yt-dlp"),
    `#!/bin/sh\necho "$*" >> "${callLog}"\necho '{"entries":[],"title":null}'\n`,
  );
  await chmod(join(bin, "yt-dlp"), 0o755);

  databasePath = join(tempDir, "test.sqlite");
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
      PATH: `${bin}:${process.env.PATH}`,
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
  await rm(tempDir, { recursive: true, force: true });
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function ytDlpCalls() {
  return (await readFile(callLog, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean);
}

describe("import URL validation", () => {
  test("non-YouTube hosts are refused before yt-dlp runs", async () => {
    const internal = "http://127.0.0.1:9/x?list=PL123";
    const preview = await post("/import/preview", { url: internal });
    expect(preview.status).toBe(400);
    expect(preview.json.message).toBe("url must be a YouTube URL");

    const single = await post("/import/preview", {
      url: "https://example.com/watch?v=abcdefghijk",
    });
    expect(single.status).toBe(400);

    const created = await post("/import", { url: internal });
    expect(created.status).toBe(400);
    expect(created.json.message).toBe("url must be a YouTube URL");

    expect(await ytDlpCalls()).toEqual([]);
    const db = new Database(databasePath, { readonly: true });
    expect(db.query("SELECT count(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    db.close();
  });

  test("an invalid playlist id or video id is a 400", async () => {
    const badList = await post("/import/preview", {
      url: "https://www.youtube.com/playlist?list=PL%20x%3Dy",
    });
    expect(badList.status).toBe(400);
    expect(badList.json.message).toBe("playlist id is not valid");

    const emptyList = await post("/import", {
      url: "https://www.youtube.com/watch?v=abcdefghijk&list=",
    });
    expect(emptyList.status).toBe(400);

    const badVideo = await post("/import/preview", {
      url: "https://www.youtube.com/watch?v=abc",
    });
    expect(badVideo.status).toBe(400);
    expect(await ytDlpCalls()).toEqual([]);
  });

  test("playlist expansion gets a URL rebuilt from the list id, after --", async () => {
    const preview = await post("/import/preview", {
      url: "music.youtube.com/playlist?list=OLAK5uy_abc123&utm=x#frag",
    });
    expect(preview.status).toBe(200);
    expect(preview.json.data.url).toBe(
      "https://music.youtube.com/playlist?list=OLAK5uy_abc123",
    );
    expect(await ytDlpCalls()).toEqual([
      "--flat-playlist -J -- https://music.youtube.com/playlist?list=OLAK5uy_abc123",
    ]);
  });
});
