import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let server: Bun.Subprocess | undefined;

const todayLog = () =>
  join(
    process.env.LOG_DIR!,
    `ingest-${new Date().toLocaleDateString("en-CA")}.jsonl`,
  );
async function records() {
  try {
    return (await readFile(todayLog(), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-route-db-log-"));
  process.env.LOG_DIR = tempDir;
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  server?.kill();
  server = undefined;
});

describe("route database failures", () => {
  test("playback, queue and read routes log route_db_* records and still answer 500", async () => {
    // The server runs in a child process with its own DB_FILE_NAME. Only tracks_table
    // exists, so every route that touches another table fails with a SQLite error.
    const { Database } = await import("bun:sqlite");
    const databasePath = join(tempDir, "test.sqlite");
    const audioPath = join(tempDir, "track.m4a");
    await writeFile(audioPath, "audio");
    const setup = new Database(databasePath);
    setup.run(`CREATE TABLE tracks_table (
      id text PRIMARY KEY NOT NULL,
      youtube_id text NOT NULL UNIQUE,
      musicbrainz_recording_id text UNIQUE,
      release_group_id text,
      title text NOT NULL,
      first_release_date integer NOT NULL,
      length integer NOT NULL,
      file_path text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )`);
    setup.run(
      `INSERT INTO tracks_table (id, youtube_id, title, first_release_date, length, file_path, created_at, updated_at)
       VALUES ('track-1', 'yt-1', 'Track', 0, 1000, ?, 0, 0)`,
      [audioPath],
    );
    setup.close();

    const port = 20000 + Math.floor(Math.random() * 20000);
    server = Bun.spawn(["bun", "src/server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_FILE_NAME: databasePath,
        BIND_HOST: "127.0.0.1",
        BIND_PORT: String(port),
        DEMO_MODE: "false",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
      try {
        await fetch(`${base}/`);
        break;
      } catch (error) {
        if (attempt > 100) throw error;
        await Bun.sleep(100);
      }
    }

    const requests = [
      {
        method: "GET",
        path: "/tracks/next",
        route: "/tracks/next",
        event: "route_db_write_failed",
      },
      {
        method: "GET",
        path: "/release-groups/rg-1/tracks",
        route: "/release-groups/:id/tracks",
        event: "route_db_read_failed",
      },
      {
        method: "POST",
        path: "/release-groups/rg-1/queue",
        route: "/release-groups/:id/queue",
        event: "route_db_write_failed",
      },
      {
        method: "POST",
        path: "/tracks/track-1/like",
        route: "/tracks/:id/like",
        event: "route_db_write_failed",
      },
      {
        method: "GET",
        path: "/tracks/track-1/stream",
        route: "/tracks/:id/stream",
        event: "route_db_write_failed",
      },
    ];
    for (const request of requests) {
      const response = await fetch(`${base}${request.path}`, {
        method: request.method,
      });
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("INTERNAL SERVER ERROR");
    }

    const failures = (await records()).filter((r) =>
      r.event?.startsWith("route_db_"),
    );
    expect(failures.map((r) => [r.route, r.method, r.event])).toEqual(
      requests.map((r) => [r.route, r.method, r.event]),
    );
    for (const failure of failures) {
      expect(failure.level).toBe("error");
      expect(failure.code).toBe("SQLITE_ERROR");
      expect(failure.error.message).toContain("no such table");
      expect(failure.error.stack).toEqual(expect.any(String));
      expect(failure.timezone).toEqual(expect.any(String));
    }
  }, 30000);
});
