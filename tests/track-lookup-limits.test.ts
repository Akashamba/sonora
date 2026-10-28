import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// Playlists, artist pages and the queue read tracks by id. None of them may drop
// tracks past the old 50-row cap.

let tempDir: string;
let server: Bun.Subprocess | undefined;
let base: string;
let databasePath: string;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function trackId(i: number) {
  return `t-${String(i).padStart(3, "0")}`;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-track-limits-"));
  databasePath = join(tempDir, "test.sqlite");
  const setup = new Database(databasePath);
  setup.exec(
    await Bun.file(
      new URL("./fixtures/playlist-schema.sql", import.meta.url),
    ).text(),
  );
  const now = Date.now();
  for (let i = 0; i < 120; i++) {
    setup.run(
      `INSERT INTO tracks_table (id, youtube_id, title, first_release_date, length, file_path, created_at, updated_at)
       VALUES (?, ?, ?, 0, 1000, ?, ?, ?)`,
      [trackId(i), `yt-${i}`, `Song ${i}`, `audio/${i}.opus`, now, now],
    );
  }
  setup.run(
    "INSERT INTO artists_table (id, name, created_at, updated_at) VALUES ('artist-big', 'Big Artist', ?, ?)",
    [now, now],
  );
  for (let i = 0; i < 60; i++) {
    setup.run(
      "INSERT INTO track_artists (track_id, artist_id, pos, joinphrase) VALUES (?, 'artist-big', 0, NULL)",
      [trackId(i)],
    );
  }
  // Queue positions are scrambled against insertion order, so the test fails
  // if the queue comes back in rowid order.
  for (let i = 0; i < 70; i++) {
    const position = ((i * 37) % 70) + 1;
    setup.run(
      "INSERT INTO queue_table (id, track_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [`q-${i}`, trackId(i), position, now, now],
    );
  }
  setup.close();

  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
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
});

afterEach(async () => {
  server?.kill();
  server = undefined;
  await rm(tempDir, { recursive: true, force: true });
});

describe("track lookups past the old 50-row cap", () => {
  test("a playlist with 120 tracks returns 120 entries in playlist order", async () => {
    const created = await api("POST", "/playlists", { name: "Long" });
    const playlistId = created.json.data.id;
    // Insert in two calls so the append path runs with multiple batches too.
    const ids = Array.from({ length: 120 }, (_, i) => trackId(i));
    const first = await api("POST", `/playlists/${playlistId}/tracks`, {
      trackIds: ids.slice(0, 60),
    });
    expect(first.json.data).toHaveLength(60);
    await api("POST", `/playlists/${playlistId}/tracks`, {
      trackIds: ids.slice(60),
    });

    const { json } = await api("GET", `/playlists/${playlistId}`);
    expect(json.data.tracks).toHaveLength(120);
    expect(json.data.tracks.map((e: any) => e.track.id)).toEqual(ids);
  });

  test("an artist with 60 tracks returns 60 tracks", async () => {
    const { json } = await api("GET", "/artists/artist-big/tracks");
    expect(json.count).toBe(60);
    expect(json.data).toHaveLength(60);
    expect(json.data.map((t: any) => t.id).sort()).toEqual(
      Array.from({ length: 60 }, (_, i) => trackId(i)).sort(),
    );
  });

  test("a queue with 70 tracks returns 70 in queue order", async () => {
    const { json } = await api("GET", "/queue");
    expect(json.count).toBe(70);
    expect(json.data).toHaveLength(70);
    // Queue position for track i is ((i * 37) % 70) + 1, so the expected order is
    // the track whose position is 1, then 2, and so on.
    const expected = Array.from({ length: 70 }, (_, p) => {
      const i = Array.from({ length: 70 }, (_, k) => k).find(
        (k) => ((k * 37) % 70) + 1 === p + 1,
      )!;
      return trackId(i);
    });
    expect(json.data.map((t: any) => t.id)).toEqual(expected);
  });
});
