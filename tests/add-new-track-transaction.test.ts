import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// addNewTrack writes the release group, track, artists and join rows in one
// transaction. These run in a child process with a temp DB so the module-level db
// connection never points at a real one.

let tempDir: string;
let databasePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-add-track-"));
  databasePath = join(tempDir, "tracks.sqlite");
  const db = new Database(databasePath);
  db.exec(
    await Bun.file(
      new URL("./fixtures/playlist-schema.sql", import.meta.url),
    ).text(),
  );
  db.close();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function runProbe(body: string) {
  const probe = join(tempDir, `probe-${crypto.randomUUID()}.ts`);
  await writeFile(
    probe,
    `const { addNewTrack } = await import(${JSON.stringify(join(process.cwd(), "src/server/db/transactions/addNewTrack.ts"))});
const { db } = await import(${JSON.stringify(join(process.cwd(), "src/server/db/index.ts"))});
const trackInfo = (credit: any[], cover: Record<string, string> = {}) => ({
  release: {
    "release-group": { id: "rg-1", "primary-type": "Album", title: "Album", ...cover },
    date: "2020-01-01",
    media: [{ position: 1, tracks: [{ position: 1, recording: { id: "rec-1" } }] }],
  },
  youtubeId: "yt-1",
  filePath: "/tmp/x.m4a",
  recording: { id: "rec-1", title: "Song", "first-release-date": "2020-01-01", length: 1000, "artist-credit": credit },
});
const good = { artist: { id: "artist-a" }, name: "A", joinphrase: " & " };
${body}
`,
  );
  const child = Bun.spawn(["bun", probe], {
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
  return JSON.parse(line!.slice("RESULT ".length));
}

function counts() {
  const db = new Database(databasePath, { readonly: true });
  const row = (sql: string) => (db.query(sql).get() as { n: number }).n;
  const result = {
    tracks: row("SELECT COUNT(*) AS n FROM tracks_table"),
    releaseGroups: row("SELECT COUNT(*) AS n FROM release_groups_table"),
    artists: row("SELECT COUNT(*) AS n FROM artists_table"),
    trackArtists: row("SELECT COUNT(*) AS n FROM track_artists"),
  };
  db.close();
  return result;
}

describe("addNewTrack transaction", () => {
  test("a failing artist insert after the track insert leaves no rows behind", async () => {
    // The second artist has no name, so its insert violates NOT NULL after the
    // track row was already written inside the transaction.
    const result = await runProbe(`
      let error = null;
      try {
        await addNewTrack(trackInfo([good, { artist: { id: "artist-b" }, name: null }]), { jobId: "job-1" });
      } catch (e) {
        error = String(e);
      }
      console.log("RESULT " + JSON.stringify({ error }));
    `);

    expect(result.error).toContain("NOT NULL");
    expect(counts()).toEqual({
      tracks: 0,
      releaseGroups: 0,
      artists: 0,
      trackArtists: 0,
    });
  });

  test("a complete track is committed with its release group, artists and join rows", async () => {
    const result = await runProbe(`
      await addNewTrack(trackInfo([good, { artist: { id: "artist-b" }, name: "B" }]), { jobId: "job-2" });
      console.log("RESULT " + JSON.stringify({ ok: true }));
    `);

    expect(result.ok).toBe(true);
    expect(counts()).toEqual({
      tracks: 1,
      releaseGroups: 1,
      artists: 2,
      trackArtists: 2,
    });
  });
});

describe("release group cover on a later track", () => {
  // A second track on the same release group, with its own video and recording.
  const secondTrack = (cover: string) => `{
    ...trackInfo([good], ${cover}),
    youtubeId: "yt-2",
    recording: { ...trackInfo([good]).recording, id: "rec-2", title: "Song 2" },
  }`;
  const coverOf = (n: string) =>
    `{ cover_art_url: "o${n}", cover_art_url_thumbnail_large: "l${n}", cover_art_url_thumbnail_small: "s${n}" }`;

  function storedCover() {
    const db = new Database(databasePath, { readonly: true });
    const row = db
      .query(
        "SELECT cover_art_url AS original, cover_art_url_thumbnail_large AS large, cover_art_url_thumbnail_small AS small FROM release_groups_table",
      )
      .get();
    db.close();
    return row;
  }

  test("fills the cover when the first track's lookup found none", async () => {
    await runProbe(`
      await addNewTrack(trackInfo([good]), { jobId: "job-1" });
      await addNewTrack(${secondTrack(coverOf("1"))}, { jobId: "job-2" });
      console.log("RESULT {}");
    `);
    expect(storedCover()).toEqual({ original: "o1", large: "l1", small: "s1" });
  });

  test("keeps a stored cover when a later track finds another or none", async () => {
    await runProbe(`
      await addNewTrack(trackInfo([good], ${coverOf("1")}), { jobId: "job-1" });
      await addNewTrack(${secondTrack(coverOf("2"))}, { jobId: "job-2" });
      console.log("RESULT {}");
    `);
    expect(storedCover()).toEqual({ original: "o1", large: "l1", small: "s1" });
    await runProbe(`
      await addNewTrack({ ...${secondTrack("{}")}, youtubeId: "yt-3", recording: { ...trackInfo([good]).recording, id: "rec-3" } }, { jobId: "job-3" });
      console.log("RESULT {}");
    `);
    expect(storedCover()).toEqual({ original: "o1", large: "l1", small: "s1" });
  });
});
