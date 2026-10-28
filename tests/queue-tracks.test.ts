import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

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
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

// Starts the server against a fresh temp DB. Album tracks are inserted in the
// order album-1..album-4, so rowid order is the album order.
async function startServer(env: Record<string, string> = {}) {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-queue-tracks-"));
  databasePath = join(tempDir, "test.sqlite");
  const setup = new Database(databasePath);
  setup.exec(
    await Bun.file(
      new URL("./fixtures/playlist-schema.sql", import.meta.url),
    ).text(),
  );
  const now = Date.now();
  setup.run(
    `INSERT INTO release_groups_table (id, musicbrainz_primary_type, title, first_release_date, created_at, updated_at)
     VALUES ('rg-1', 'Album', 'Album One', 0, ?, ?)`,
    [now, now],
  );
  const tracksToInsert: [string, string | null][] = [
    ["track-a", null],
    ["track-b", null],
    ["track-c", null],
    ["album-1", "rg-1"],
    ["album-2", "rg-1"],
    ["album-3", "rg-1"],
    ["album-4", "rg-1"],
  ];
  for (const [id, releaseGroupId] of tracksToInsert) {
    setup.run(
      `INSERT INTO tracks_table (id, youtube_id, release_group_id, title, first_release_date, length, file_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 1000, ?, ?, ?)`,
      [
        id,
        `yt-${id}`,
        releaseGroupId,
        `Song ${id}`,
        `audio/${id}.opus`,
        now,
        now,
      ],
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
      ...env,
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
}

beforeEach(async () => {
  await startServer();
});

afterEach(async () => {
  server?.kill();
  server = undefined;
  await rm(tempDir, { recursive: true, force: true });
});

function rowsWhere(sql: string, params: unknown[] = []) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.query(sql).all(...(params as any[])) as any[];
  } finally {
    db.close();
  }
}

function queueOrder() {
  return rowsWhere("SELECT track_id FROM queue_table ORDER BY position").map(
    (row) => row.track_id as string,
  );
}

// Seeds the queue with two entries that should stay behind anything inserted at the top.
function seedQueue() {
  const db = new Database(databasePath);
  db.run(
    "INSERT INTO queue_table (id, track_id, position, created_at, updated_at) VALUES ('q1', 'track-c', 1, 0, 0), ('q2', 'track-b', 2, 0, 0)",
  );
  db.close();
}

describe("POST /queue/tracks", () => {
  test("inserts the tracks in the given order and returns the first", async () => {
    const res = await api("POST", "/queue/tracks", {
      trackIds: ["track-c", "track-a", "track-b"],
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ data: { track_id: "track-c" } });
    expect(queueOrder()).toEqual(["track-c", "track-a", "track-b"]);
  });

  test("puts the tracks above the existing queue entries", async () => {
    seedQueue();
    const res = await api("POST", "/queue/tracks", {
      trackIds: ["track-a", "track-b"],
    });
    expect(res.json.data.track_id).toBe("track-a");
    expect(queueOrder()).toEqual(["track-a", "track-b", "track-c", "track-b"]);
  });

  test("a single id is a play next", async () => {
    seedQueue();
    await api("POST", "/queue/tracks", { trackIds: ["track-a"] });
    expect(queueOrder()).toEqual(["track-a", "track-c", "track-b"]);
  });

  test("shuffle produces a permutation of the input", async () => {
    const ids = [
      "album-1",
      "album-2",
      "album-3",
      "album-4",
      "track-a",
      "track-b",
      "track-c",
    ];
    const res = await api("POST", "/queue/tracks", {
      trackIds: ids,
      shuffle: true,
    });
    expect(res.status).toBe(200);
    expect(queueOrder().slice().sort()).toEqual(ids.slice().sort());
    expect(res.json.data.track_id).toBe(queueOrder()[0]!);
  });

  test("duplicate ids are kept in the queue", async () => {
    await api("POST", "/queue/tracks", { trackIds: ["track-a", "track-a"] });
    expect(queueOrder()).toEqual(["track-a", "track-a"]);
  });

  test("Up Next lists every queue row, duplicates included", async () => {
    await api("POST", "/queue/tracks", { trackIds: ["track-a", "track-a"] });
    const upNext = await api("GET", "/queue");
    expect(upNext.json.data.map((track: any) => track.id)).toEqual([
      "track-a",
      "track-a",
    ]);
    const positions = upNext.json.data.map((track: any) => track.position);
    expect(positions[0]).toBeLessThan(positions[1]);
  });

  test("rejects bodies that are not a non-empty list of ids", async () => {
    const bad = [
      undefined,
      {},
      { trackIds: [] },
      { trackIds: "track-a" },
      { trackIds: ["track-a", 3] },
      { trackIds: ["track-a", ""] },
      { trackIds: Array.from({ length: 1001 }, () => "track-a") },
      { trackIds: ["track-a"], shuffle: "yes" },
    ];
    for (const body of bad) {
      const res = await api("POST", "/queue/tracks", body);
      expect(res.status).toBe(400);
    }
    const raw = await fetch(`${base}/queue/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(raw.status).toBe(400);
    expect(queueOrder()).toEqual([]);
  });

  test("unknown ids fail with 400 listing them and insert nothing", async () => {
    const res = await api("POST", "/queue/tracks", {
      trackIds: ["track-a", "ghost-1", "track-b", "ghost-2"],
    });
    expect(res.status).toBe(400);
    expect(res.json.unknownIds).toEqual(["ghost-1", "ghost-2"]);
    expect(queueOrder()).toEqual([]);
  });
});

describe("queue routes with ?shuffle=1", () => {
  test("release group queue follows album insertion order", async () => {
    const plain = await api("POST", "/release-groups/rg-1/queue");
    expect(plain.json.data.track_id).toBe("album-1");
    expect(queueOrder()).toEqual(["album-1", "album-2", "album-3", "album-4"]);
  });

  test("release group queue inserts into an empty queue", async () => {
    // Regression: the old code computed NaN positions when the queue was empty.
    const res = await api("POST", "/release-groups/rg-1/queue");
    expect(res.status).toBe(200);
    expect(queueOrder()).toHaveLength(4);
  });

  test("release group shuffle is a permutation above the existing queue", async () => {
    seedQueue();
    const res = await api("POST", "/release-groups/rg-1/queue?shuffle=1");
    expect(res.status).toBe(200);
    const order = queueOrder();
    expect(order.slice(0, 4).slice().sort()).toEqual([
      "album-1",
      "album-2",
      "album-3",
      "album-4",
    ]);
    expect(order.slice(4)).toEqual(["track-c", "track-b"]);
    expect(res.json.data.track_id).toBe(order[0]!);
  });

  test("playlist queue goes to the top and honours ?shuffle=1", async () => {
    const { json: created } = await api("POST", "/playlists", { name: "Mix" });
    const playlistId = created.data.id as string;
    await api("POST", `/playlists/${playlistId}/tracks`, {
      trackIds: ["track-a", "track-b", "track-c"],
    });
    seedQueue();

    const plain = await api("POST", `/playlists/${playlistId}/queue`);
    expect(plain.json.data.track_id).toBe("track-a");
    expect(queueOrder()).toEqual([
      "track-a",
      "track-b",
      "track-c",
      "track-c",
      "track-b",
    ]);

    await api("POST", `/playlists/${playlistId}/queue?shuffle=1`);
    const order = queueOrder();
    expect(order.slice(0, 3).slice().sort()).toEqual([
      "track-a",
      "track-b",
      "track-c",
    ]);
    expect(order.slice(3)).toEqual([
      "track-a",
      "track-b",
      "track-c",
      "track-c",
      "track-b",
    ]);
  });
});

// Seeds 30 rows at positions 1..30. Above the refill threshold, so a play-from
// does not pull in library tracks and the remaining order stays exact.
function seedLongQueue() {
  const ids = ["track-a", "track-b", "track-c"];
  const db = new Database(databasePath);
  for (let i = 1; i <= 30; i++) {
    db.run(
      "INSERT INTO queue_table (id, track_id, position, created_at, updated_at) VALUES (?, ?, ?, 0, 0)",
      [`q${i}`, ids[i % 3]!, i],
    );
  }
  db.close();
}

function queuePositions() {
  return rowsWhere("SELECT position FROM queue_table ORDER BY position").map(
    (row) => row.position as number,
  );
}

describe("POST /queue/play-from", () => {
  test("plays the row at the position and drops the rows above it", async () => {
    seedLongQueue();
    const res = await api("POST", "/queue/play-from", { position: 4 });
    expect(res.status).toBe(200);
    // Position 4 is track-b (4 % 3 === 1 -> ids[1]).
    expect(res.json).toEqual({ data: { track_id: "track-b" } });
    // Rows 1..4 are gone, 5..30 stay in order.
    expect(queuePositions()).toEqual(
      Array.from({ length: 26 }, (_, i) => i + 5),
    );
  });

  test("pops the target row once it plays", async () => {
    seedLongQueue();
    await api("POST", "/queue/play-from", { position: 1 });
    expect(queuePositions()).not.toContain(1);
    expect(queuePositions()).toHaveLength(29);
  });

  test("a short queue refills before the pop and still plays the target", async () => {
    seedQueue();
    // Rows are track-c@1 and track-b@2. Playing position 2 drops track-c and refills
    // from the library (7 tracks) before popping track-b.
    const res = await api("POST", "/queue/play-from", { position: 2 });
    expect(res.json).toEqual({ data: { track_id: "track-b" } });
    const positions = queuePositions();
    expect(positions).toHaveLength(7);
    expect(Math.min(...positions)).toBeGreaterThan(2);
  });

  test("a position with no row is 404 and writes nothing", async () => {
    seedLongQueue();
    const before = queuePositions();
    const res = await api("POST", "/queue/play-from", { position: 99.5 });
    expect(res.status).toBe(404);
    expect(queuePositions()).toEqual(before);
  });

  test("rejects a missing or non-numeric position with 400", async () => {
    seedLongQueue();
    const before = queuePositions();
    const bad: unknown[] = [
      undefined,
      {},
      { position: "2" },
      { position: null },
    ];
    for (const body of bad) {
      const res = await api("POST", "/queue/play-from", body);
      expect(res.status).toBe(400);
    }
    const raw = await fetch(`${base}/queue/play-from`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(raw.status).toBe(400);
    expect(queuePositions()).toEqual(before);
  });

  test("Up Next positions from GET /queue select the right row", async () => {
    seedLongQueue();
    const upNext = await api("GET", "/queue");
    const third = upNext.json.data[2];
    const res = await api("POST", "/queue/play-from", {
      position: third.position,
    });
    expect(res.json.data.track_id).toBe(third.id);
    expect(queuePositions()[0]).toBe(4);
  });
});

describe("demo mode", () => {
  test("queue writes are blocked", async () => {
    server?.kill();
    await rm(tempDir, { recursive: true, force: true });
    await startServer({ DEMO_MODE: "true" });

    expect(
      (await api("POST", "/queue/tracks", { trackIds: ["track-a"] })).status,
    ).toBe(403);
    expect((await api("POST", "/release-groups/rg-1/queue")).status).toBe(403);
    expect(
      (await api("POST", "/queue/play-from", { position: 1 })).status,
    ).toBe(403);
    expect(queueOrder()).toEqual([]);
  });
});
