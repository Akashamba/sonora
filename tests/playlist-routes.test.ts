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
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-playlist-routes-"));
  databasePath = join(tempDir, "test.sqlite");
  const setup = new Database(databasePath);
  setup.exec(
    await Bun.file(
      new URL("./fixtures/playlist-schema.sql", import.meta.url),
    ).text(),
  );
  const now = Date.now();
  for (const [id, youtubeId] of [
    ["track-a", "yt-aaaaaaaa"],
    ["track-b", "yt-bbbbbbbb"],
    ["track-c", "yt-cccccccc"],
  ] as [string, string][]) {
    setup.run(
      `INSERT INTO tracks_table (id, youtube_id, title, first_release_date, length, file_path, created_at, updated_at)
       VALUES (?, ?, ?, 0, 1000, ?, ?, ?)`,
      [id, youtubeId, `Song ${id}`, `audio/${id}.opus`, now, now],
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

function rowsWhere(sql: string, params: unknown[] = []) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.query(sql).all(...(params as any[])) as any[];
  } finally {
    db.close();
  }
}

async function orderOf(playlistId: string) {
  const { json } = await api("GET", `/playlists/${playlistId}`);
  return json.data.tracks.map((entry: any) => entry.track.id as string);
}

describe("playlist routes", () => {
  test("create validates the name and returns the playlist", async () => {
    expect((await api("POST", "/playlists", { name: "   " })).status).toBe(400);
    const created = await api("POST", "/playlists", { name: " Running " });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ name: "Running", trackCount: 0 });
    const list = await api("GET", "/playlists");
    expect(list.json.count).toBe(1);
  });

  test("add appends entries in order, then reorder moves them with afterEntryId", async () => {
    const { json: created } = await api("POST", "/playlists", { name: "Mix" });
    const playlistId = created.data.id as string;

    const added = await api("POST", `/playlists/${playlistId}/tracks`, {
      trackIds: ["track-a", "track-b", "track-c"],
    });
    expect(added.status).toBe(200);
    const [entryA, entryB, entryC] = added.json.data.map(
      (entry: any) => entry.entryId as string,
    );
    expect(added.json.data.map((entry: any) => entry.position)).toEqual([
      0, 1, 2,
    ]);
    expect(await orderOf(playlistId)).toEqual([
      "track-a",
      "track-b",
      "track-c",
    ]);

    // Move a to the end, then c between a and b, then a back to the top.
    const toEnd = await api(
      "PATCH",
      `/playlists/${playlistId}/tracks/${entryA}`,
      { afterEntryId: entryC },
    );
    expect(toEnd.status).toBe(200);
    expect(await orderOf(playlistId)).toEqual([
      "track-b",
      "track-c",
      "track-a",
    ]);

    await api("PATCH", `/playlists/${playlistId}/tracks/${entryC}`, {
      afterEntryId: entryA,
    });
    expect(await orderOf(playlistId)).toEqual([
      "track-b",
      "track-a",
      "track-c",
    ]);

    await api("PATCH", `/playlists/${playlistId}/tracks/${entryC}`, {
      afterEntryId: null,
    });
    expect(await orderOf(playlistId)).toEqual([
      "track-c",
      "track-b",
      "track-a",
    ]);
  });

  test("reorder rejects an unknown anchor or entry", async () => {
    const { json: created } = await api("POST", "/playlists", { name: "Mix" });
    const playlistId = created.data.id as string;
    const added = await api("POST", `/playlists/${playlistId}/tracks`, {
      trackIds: ["track-a", "track-b"],
    });
    const [entryA] = added.json.data.map(
      (entry: any) => entry.entryId as string,
    );

    expect(
      (
        await api("PATCH", `/playlists/${playlistId}/tracks/${entryA}`, {
          afterEntryId: "missing",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("PATCH", `/playlists/${playlistId}/tracks/missing`, {
          afterEntryId: null,
        })
      ).status,
    ).toBe(404);
  });

  test("remove deletes one entry and leaves the rest in order", async () => {
    const { json: created } = await api("POST", "/playlists", { name: "Mix" });
    const playlistId = created.data.id as string;
    const added = await api("POST", `/playlists/${playlistId}/tracks`, {
      trackIds: ["track-a", "track-b", "track-c"],
    });
    const entryB = added.json.data[1].entryId as string;

    expect(
      (await api("DELETE", `/playlists/${playlistId}/tracks/${entryB}`)).status,
    ).toBe(204);
    expect(await orderOf(playlistId)).toEqual(["track-a", "track-c"]);
  });

  test("queue appends the playlist tracks in order and refuses an empty playlist", async () => {
    const { json: created } = await api("POST", "/playlists", { name: "Mix" });
    const playlistId = created.data.id as string;
    expect((await api("POST", `/playlists/${playlistId}/queue`)).status).toBe(
      400,
    );

    await api("POST", `/playlists/${playlistId}/tracks`, {
      trackIds: ["track-b", "track-a"],
    });
    const queued = await api("POST", `/playlists/${playlistId}/queue`);
    expect(queued.status).toBe(200);
    expect(queued.json.data.track_id).toBe("track-b");
    const queue = rowsWhere(
      "SELECT track_id FROM queue_table ORDER BY position",
    );
    expect(queue.map((row) => row.track_id)).toEqual(["track-b", "track-a"]);
  });

  test("delete removes the playlist and its entries", async () => {
    const { json: created } = await api("POST", "/playlists", { name: "Mix" });
    const playlistId = created.data.id as string;
    await api("POST", `/playlists/${playlistId}/tracks`, {
      trackIds: ["track-a"],
    });

    expect((await api("DELETE", `/playlists/${playlistId}`)).status).toBe(204);
    expect((await api("GET", `/playlists/${playlistId}`)).status).toBe(404);
    expect(
      rowsWhere("SELECT id FROM playlist_tracks WHERE playlist_id = ?", [
        playlistId,
      ]),
    ).toEqual([]);
  });
});

function writeDb(sql: string, params: unknown[] = []) {
  const db = new Database(databasePath);
  try {
    db.query(sql).run(...(params as any[]));
  } finally {
    db.close();
  }
}

async function newPlaylist(name = "Mix") {
  const { json } = await api("POST", "/playlists", { name });
  return json.data.id as string;
}

describe("playlist entry and validation rules", () => {
  test("an entry id from another playlist is a 404 and is not removed", async () => {
    const first = await newPlaylist("First");
    const second = await newPlaylist("Second");
    const added = await api("POST", `/playlists/${first}/tracks`, {
      trackIds: ["track-a"],
    });
    const entryId = added.json.data[0].entryId as string;

    expect(
      (await api("DELETE", `/playlists/${second}/tracks/${entryId}`)).status,
    ).toBe(404);
    expect(await orderOf(first)).toEqual(["track-a"]);
    expect(
      (
        await api("PATCH", `/playlists/${second}/tracks/${entryId}`, {
          afterEntryId: null,
        })
      ).status,
    ).toBe(404);
  });

  test("add checks the playlist and every track before inserting anything", async () => {
    const playlistId = await newPlaylist();
    const missingPlaylist = await api("POST", "/playlists/nope/tracks", {
      trackIds: ["track-a"],
    });
    expect(missingPlaylist.status).toBe(404);

    const unknown = await api("POST", `/playlists/${playlistId}/tracks`, {
      trackIds: ["track-a", "ghost-1", "track-b", "ghost-2"],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json.unknownIds).toEqual(["ghost-1", "ghost-2"]);
    expect(
      rowsWhere("SELECT id FROM playlist_tracks WHERE playlist_id = ?", [
        playlistId,
      ]),
    ).toEqual([]);
  });

  test("a track deleted without its cascade is hidden, and the playlist still queues", async () => {
    const playlistId = await newPlaylist();
    await api("POST", `/playlists/${playlistId}/tracks`, {
      trackIds: ["track-b", "track-a"],
    });
    // Foreign keys are off on the server connection, so this leaves a ghost row.
    writeDb("DELETE FROM tracks_table WHERE id = ?", ["track-b"]);

    const list = await api("GET", "/playlists");
    expect(list.json.data[0].trackCount).toBe(1);
    expect(await orderOf(playlistId)).toEqual(["track-a"]);

    const queued = await api("POST", `/playlists/${playlistId}/queue`);
    expect(queued.status).toBe(200);
    expect(queued.json.data.track_id).toBe("track-a");

    // Reordering still works around the ghost row.
    const [entryA] = (
      await api("GET", `/playlists/${playlistId}`)
    ).json.data.tracks.map((entry: any) => entry.entryId as string);
    expect(
      (
        await api("PATCH", `/playlists/${playlistId}/tracks/${entryA}`, {
          afterEntryId: null,
        })
      ).status,
    ).toBe(200);
  });

  test("an unknown playlist cannot be queued", async () => {
    expect((await api("POST", "/playlists/nope/queue")).status).toBe(404);
  });

  test("invalid JSON bodies are 400 with a message", async () => {
    const playlistId = await newPlaylist();
    const badJson = async (method: string, path: string) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      return { status: res.status, json: await res.json() };
    };
    for (const [method, path] of [
      ["POST", "/playlists"],
      ["PATCH", `/playlists/${playlistId}`],
      ["POST", `/playlists/${playlistId}/tracks`],
      ["PATCH", `/playlists/${playlistId}/tracks/x`],
    ] as const) {
      const res = await badJson(method, path);
      expect(res.status).toBe(400);
      expect(res.json.message).toBe("invalid or empty JSON body");
    }
  });

  test("rename rejects an empty name and keeps the old one", async () => {
    const playlistId = await newPlaylist("Keep");
    expect(
      (await api("PATCH", `/playlists/${playlistId}`, { name: "   " })).status,
    ).toBe(400);
    const { json } = await api("GET", `/playlists/${playlistId}`);
    expect(json.data.name).toBe("Keep");
  });

  test("reorder needs afterEntryId, and null still moves to the top", async () => {
    const playlistId = await newPlaylist();
    const added = await api("POST", `/playlists/${playlistId}/tracks`, {
      trackIds: ["track-a", "track-b"],
    });
    const entryB = added.json.data[1].entryId as string;
    const missing = await api(
      "PATCH",
      `/playlists/${playlistId}/tracks/${entryB}`,
      {},
    );
    expect(missing.status).toBe(400);
    expect(missing.json.message).toBe("afterEntryId is required");

    expect(
      (
        await api("PATCH", `/playlists/${playlistId}/tracks/${entryB}`, {
          afterEntryId: null,
        })
      ).status,
    ).toBe(200);
    expect(await orderOf(playlistId)).toEqual(["track-b", "track-a"]);
  });

  test("the imports list clamps a non-numeric limit", async () => {
    const res = await api("GET", "/imports?limit=abc");
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual([]);
  });
});

describe("playlist positions", () => {
  // An import linked to the playlist with its jobs still queued: job.position is the
  // slot the worker writes into the playlist.
  function linkPendingImport(playlistId: string, slots: number[]) {
    writeDb(
      `INSERT INTO imports (id, source_url, mode, playlist_id, created_at, updated_at)
       VALUES ('imp-1', 'https://www.youtube.com/playlist?list=PLx', 'playlist', ?, 0, 0)`,
      [playlistId],
    );
    for (const [i, position] of slots.entries())
      writeDb(
        `INSERT INTO jobs (id, url, status, import_id, position, created_at, updated_at)
         VALUES (?, ?, 'queued', 'imp-1', ?, 0, 0)`,
        [`job-${i}`, `https://www.youtube.com/watch?v=job${i}`, position],
      );
  }

  test("an append goes after the pending job slots of a linked import", async () => {
    const playlistId = await newPlaylist();
    linkPendingImport(playlistId, [0, 1, 2, 3, 4]);
    const added = await api("POST", `/playlists/${playlistId}/tracks`, {
      trackIds: ["track-a"],
    });
    expect(added.json.data[0].position).toBe(5);
  });

  test("many moves into one gap keep the order and never 500", async () => {
    const playlistId = await newPlaylist();
    const added = await api("POST", `/playlists/${playlistId}/tracks`, {
      trackIds: ["track-a", "track-b", "track-c"],
    });
    const [entryA, entryB, entryC] = added.json.data.map(
      (entry: any) => entry.entryId as string,
    );
    // Around 1000 a double has about 1e-13 of precision. Alternating two entries
    // between track-a and the other one halves the gap on every move, so the gap runs
    // out after about 40 moves.
    writeDb("UPDATE playlist_tracks SET position = 1000 WHERE id = ?", [
      entryA,
    ]);
    writeDb("UPDATE playlist_tracks SET position = 1001 WHERE id = ?", [
      entryB,
    ]);
    for (let i = 0; i < 60; i++) {
      const mover = i % 2 === 0 ? entryC : entryB;
      const res = await api(
        "PATCH",
        `/playlists/${playlistId}/tracks/${mover}`,
        { afterEntryId: entryA },
      );
      expect(res.status).toBe(200);
    }
    expect(await orderOf(playlistId)).toEqual([
      "track-a",
      "track-b",
      "track-c",
    ]);
  });

  test("a reorder never puts an entry on a pending job slot", async () => {
    const playlistId = await newPlaylist();
    const added = await api("POST", `/playlists/${playlistId}/tracks`, {
      trackIds: ["track-a", "track-b"],
    });
    const [entryA, entryB] = added.json.data.map(
      (entry: any) => entry.entryId as string,
    );
    // track-a at 0, track-b at 10, and pending job slots 1 to 3 in between.
    writeDb("UPDATE playlist_tracks SET position = 10 WHERE id = ?", [entryB]);
    linkPendingImport(playlistId, [1, 2, 3]);

    // Moving track-b after track-a would land on slot 1, so the playlist is renumbered
    // around the slots.
    expect(
      (
        await api("PATCH", `/playlists/${playlistId}/tracks/${entryB}`, {
          afterEntryId: entryA,
        })
      ).status,
    ).toBe(200);
    expect(await orderOf(playlistId)).toEqual(["track-a", "track-b"]);
    const slotsTaken = () =>
      rowsWhere(
        "SELECT position FROM playlist_tracks WHERE playlist_id = ? AND position IN (1, 2, 3)",
        [playlistId],
      );
    expect(slotsTaken()).toEqual([]);

    // Moving track-b to the top keeps it on the top side of the slots too.
    expect(
      (
        await api("PATCH", `/playlists/${playlistId}/tracks/${entryB}`, {
          afterEntryId: null,
        })
      ).status,
    ).toBe(200);
    expect(await orderOf(playlistId)).toEqual(["track-b", "track-a"]);
    expect(slotsTaken()).toEqual([]);
  });
});
