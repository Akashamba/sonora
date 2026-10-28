import { beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-track-metadata-"));
});

// Fixture: one release group, artists, and tracks that exercise the joins in
// fetchTracksWithMetadata (history, play_stats, queue, track_artists).
//  - solo: one artist, four plays, queued once
//  - duo: two artists, two plays, queued twice (two queue rows)
//  - trio: three artists inserted out of pos order, one play, not queued
//  - bulk-01..bulk-12: three artists each, played in order (bulk-12 most recent),
//    bulk tracks 01-10 queued twice so the joined rows exceed 50
function seed(databasePath: string) {
  const setup = new Database(databasePath);
  setup.exec(`
    CREATE TABLE artists_table (
      id text PRIMARY KEY, musicbrainz_id text UNIQUE, name text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL);
    CREATE TABLE release_groups_table (
      id text PRIMARY KEY, musicbrainz_release_group_id text UNIQUE,
      musicbrainz_primary_type text NOT NULL, title text NOT NULL,
      cover_art_url text, first_release_date integer NOT NULL,
      cover_art_url_thumbnail_large text, cover_art_url_thumbnail_small text,
      created_at integer NOT NULL, updated_at integer NOT NULL);
    CREATE TABLE tracks_table (
      id text PRIMARY KEY, youtube_id text NOT NULL UNIQUE,
      musicbrainz_recording_id text UNIQUE, release_group_id text,
      title text NOT NULL, first_release_date integer NOT NULL,
      length integer NOT NULL, file_path text NOT NULL, disc_number integer, track_number integer,
      created_at integer NOT NULL, updated_at integer NOT NULL);
    CREATE TABLE track_artists (
      track_id text, artist_id text, pos integer NOT NULL, joinphrase text);
    CREATE TABLE history_table (
      id text PRIMARY KEY, track_id text, completed integer DEFAULT 0,
      created_at integer NOT NULL, updated_at integer NOT NULL);
    CREATE TABLE play_stats_table (
      id text PRIMARY KEY, track_id text UNIQUE, count integer DEFAULT 1,
      liked integer DEFAULT 0, created_at integer NOT NULL,
      updated_at integer NOT NULL);
    CREATE TABLE queue_table (
      id text PRIMARY KEY, track_id text, position real NOT NULL UNIQUE,
      created_at integer NOT NULL, updated_at integer NOT NULL);
  `);
  const now = 1_700_000_000_000;
  const run = (sql: string, ...params: unknown[]) =>
    setup.run(sql, params as any[]);

  run(
    "INSERT INTO release_groups_table VALUES ('rg-1', NULL, 'Album', 'Album', NULL, 0, NULL, NULL, ?, ?)",
    now,
    now,
  );
  for (const [id, name] of [
    ["artist-kiasmos", "Kiasmos"],
    ["artist-frost", "Ben Frost"],
    ["artist-jonsi", "Jónsi"],
    ["artist-amiina", "amiina"],
  ]) {
    run(
      "INSERT INTO artists_table VALUES (?, NULL, ?, ?, ?)",
      id,
      name,
      now,
      now,
    );
  }

  const addTrack = (id: string, title = `Song ${id}`) =>
    run(
      "INSERT INTO tracks_table VALUES (?, ?, NULL, 'rg-1', ?, 0, 1000, ?, NULL, NULL, ?, ?)",
      id,
      `yt-${id}`,
      title,
      `audio/${id}.opus`,
      now,
      now,
    );
  const credit = (trackId: string, artistId: string, pos: number) =>
    run(
      "INSERT INTO track_artists VALUES (?, ?, ?, ?)",
      trackId,
      artistId,
      pos,
      pos === 0 ? ", " : null,
    );
  let historyNo = 0;
  const play = (trackId: string) =>
    run(
      "INSERT INTO history_table VALUES (?, ?, 1, ?, ?)",
      `h-${String(++historyNo).padStart(3, "0")}`,
      trackId,
      now,
      now,
    );
  let queueNo = 0;
  const enqueue = (trackId: string) =>
    run(
      "INSERT INTO queue_table VALUES (?, ?, ?, ?, ?)",
      `q-${++queueNo}`,
      trackId,
      queueNo,
      now,
      now,
    );
  const stats = (trackId: string, count: number) =>
    run(
      "INSERT INTO play_stats_table VALUES (?, ?, ?, 0, ?, ?)",
      `ps-${trackId}`,
      trackId,
      count,
      now,
      now,
    );

  addTrack("solo", "Solo");
  credit("solo", "artist-kiasmos", 0);
  stats("solo", 4);
  for (let i = 0; i < 4; i++) play("solo");
  enqueue("solo");

  addTrack("duo", "Duo");
  credit("duo", "artist-kiasmos", 0);
  credit("duo", "artist-frost", 1);
  stats("duo", 2);
  play("duo");
  play("duo");
  enqueue("duo");
  enqueue("duo");

  addTrack("trio", "Trio");
  credit("trio", "artist-amiina", 2);
  credit("trio", "artist-kiasmos", 0);
  credit("trio", "artist-jonsi", 1);
  stats("trio", 1);
  play("trio");

  // Bulk tracks: play counts 11..22 (above the other tracks), so topTracks is bulk-12 .. bulk-03.
  for (let n = 1; n <= 12; n++) {
    const id = `bulk-${String(n).padStart(2, "0")}`;
    addTrack(id);
    credit(id, "artist-kiasmos", 0);
    credit(id, "artist-frost", 1);
    credit(id, "artist-jonsi", 2);
    stats(id, n + 10);
    play(id);
    if (n <= 10) {
      enqueue(id);
      enqueue(id);
    }
  }
  setup.close();
}

// Calls fetchTracksWithMetadata in a child process with DB_FILE_NAME set to a temp
// DB, so the module-level db connection points at the fixture.
async function queryTracks(opts: Record<string, unknown>) {
  const databasePath = join(tempDir, "test.sqlite");
  seed(databasePath);
  const probe = join(tempDir, "probe.ts");
  await writeFile(
    probe,
    `const { fetchTracksWithMetadata } = await import(${JSON.stringify(join(process.cwd(), "src/server/db/queries/fetchTrackWithMetadata.ts"))});
console.log("RESULT " + JSON.stringify(fetchTracksWithMetadata(${JSON.stringify(opts)})));
`,
  );
  const child = Bun.spawn([process.execPath, probe], {
    cwd: process.cwd(),
    env: { ...process.env, DB_FILE_NAME: databasePath, LOG_DIR: tempDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const line = stdout.split("\n").find((text) => text.startsWith("RESULT "));
  return JSON.parse(line!.slice("RESULT ".length)) as any[];
}

function artistIds(track: any) {
  return track.artists.map((artist: any) => artist.id);
}

describe("fetchTracksWithMetadata artists", () => {
  test("a track with one artist and several plays and queue rows lists the artist once", async () => {
    const [solo] = await queryTracks({ trackId: "solo" });
    expect(solo.id).toBe("solo");
    expect(solo.artists).toEqual([
      { id: "artist-kiasmos", name: "Kiasmos", pos: 0, joinphrase: ", " },
    ]);
  });

  test("trackIds returns each artist once, in pos order", async () => {
    const tracks = await queryTracks({ trackIds: ["duo", "solo", "trio"] });
    expect(tracks.map((track) => track.id).sort()).toEqual([
      "duo",
      "solo",
      "trio",
    ]);
    const byId = Object.fromEntries(tracks.map((track) => [track.id, track]));
    expect(artistIds(byId.solo)).toEqual(["artist-kiasmos"]);
    expect(artistIds(byId.duo)).toEqual(["artist-kiasmos", "artist-frost"]);
    expect(artistIds(byId.trio)).toEqual([
      "artist-kiasmos",
      "artist-jonsi",
      "artist-amiina",
    ]);
    expect(byId.trio.artists.map((artist: any) => artist.pos)).toEqual([
      0, 1, 2,
    ]);
  });

  test("queueTracks lists one item per queue row, in queue order", async () => {
    const tracks = await queryTracks({
      trackIds: ["duo", "solo"],
      queueTracks: true,
    });
    // duo has two queue rows (positions 2 and 3), so it appears twice.
    expect(tracks.map((track) => track.id)).toEqual(["solo", "duo", "duo"]);
    expect(tracks.map((track) => track.position)).toEqual([1, 2, 3]);
    expect(artistIds(tracks[1])).toEqual(["artist-kiasmos", "artist-frost"]);
    expect(artistIds(tracks[2])).toEqual(["artist-kiasmos", "artist-frost"]);
  });

  test("query lists each matching track once with all its artists", async () => {
    const tracks = await queryTracks({ query: "Kiasmos", limit: 50 });
    const ids = tracks.map((track) => track.id).sort();
    expect(ids).toEqual([
      "bulk-01",
      "bulk-02",
      "bulk-03",
      "bulk-04",
      "bulk-05",
      "bulk-06",
      "bulk-07",
      "bulk-08",
      "bulk-09",
      "bulk-10",
      "bulk-11",
      "bulk-12",
      "duo",
      "solo",
      "trio",
    ]);
    for (const track of tracks) {
      expect(new Set(artistIds(track)).size).toBe(artistIds(track).length);
    }
    const trio = tracks.find((track) => track.id === "trio");
    expect(artistIds(trio)).toEqual([
      "artist-kiasmos",
      "artist-jonsi",
      "artist-amiina",
    ]);
  });

  test("topTracks returns the 10 most played tracks, most played first, each artist once", async () => {
    const tracks = await queryTracks({ topTracks: true });
    expect(tracks.map((track) => track.id)).toEqual([
      "bulk-12",
      "bulk-11",
      "bulk-10",
      "bulk-09",
      "bulk-08",
      "bulk-07",
      "bulk-06",
      "bulk-05",
      "bulk-04",
      "bulk-03",
    ]);
    for (const track of tracks) {
      expect(artistIds(track)).toEqual([
        "artist-kiasmos",
        "artist-frost",
        "artist-jonsi",
      ]);
    }
  });

  test("recentTracks returns the 10 most recently played tracks, newest first, none dropped", async () => {
    const tracks = await queryTracks({ recentTracks: true });
    expect(tracks.map((track) => track.id)).toEqual([
      "bulk-12",
      "bulk-11",
      "bulk-10",
      "bulk-09",
      "bulk-08",
      "bulk-07",
      "bulk-06",
      "bulk-05",
      "bulk-04",
      "bulk-03",
    ]);
    for (const track of tracks) {
      expect(artistIds(track)).toEqual([
        "artist-kiasmos",
        "artist-frost",
        "artist-jonsi",
      ]);
    }
  });
});
