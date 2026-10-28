import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

let tempDir: string | undefined;
let server: Bun.Subprocess | undefined;

// Starts the server on a fresh temp DB holding the given track ids (may be empty).
async function startServer(trackIds: string[]) {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-tracks-next-"));
  const databasePath = join(tempDir, "test.sqlite");
  const setup = new Database(databasePath);
  setup.exec(
    await Bun.file(
      new URL("./fixtures/playlist-schema.sql", import.meta.url),
    ).text(),
  );
  const now = Date.now();
  for (const id of trackIds) {
    setup.run(
      `INSERT INTO tracks_table (id, youtube_id, title, first_release_date, length, file_path, created_at, updated_at)
       VALUES (?, ?, ?, 0, 1000, ?, ?, ?)`,
      [id, `yt-${id}`, `Song ${id}`, `audio/${id}.opus`, now, now],
    );
  }
  setup.close();

  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  server = Bun.spawn(["bun", "src/server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
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
  return { base, databasePath };
}

afterEach(async () => {
  server?.kill();
  server = undefined;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("GET /tracks/next", () => {
  test("an empty library answers 504 instead of 500", async () => {
    const { base } = await startServer([]);
    const res = await fetch(`${base}/tracks/next`);
    expect(res.status).toBe(504);
    expect((await res.json()).error).toContain("Queue is empty");
  });

  test("an empty queue with songs in the library refills first and answers with a track", async () => {
    const { base, databasePath } = await startServer(["track-a", "track-b"]);
    // The queue starts empty. The refill runs before the pop, so this call plays a track.
    const res = await fetch(`${base}/tracks/next`);
    expect(res.status).toBe(200);
    expect(["track-a", "track-b"]).toContain((await res.json()).data.track_id);

    // Both songs went into the queue and one was popped for the answer.
    const queued = new Database(databasePath, { readonly: true });
    const count = queued
      .query("SELECT count(*) AS n FROM queue_table")
      .get() as { n: number };
    queued.close();
    expect(count.n).toBe(1);

    const next = await fetch(`${base}/tracks/next`);
    expect(next.status).toBe(200);
    expect(["track-a", "track-b"]).toContain((await next.json()).data.track_id);
  });
});
