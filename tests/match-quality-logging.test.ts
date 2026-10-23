import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
let tempDir: string;

const todayLog = () =>
  join(process.env.LOG_DIR!, `ingest-${new Date().toLocaleDateString("en-CA")}.jsonl`);
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
function response(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}
async function fakeYtDlp(script: string) {
  const bin = join(tempDir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "yt-dlp"), `#!/bin/sh\n${script}\n`);
  await chmod(join(bin, "yt-dlp"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-match-log-"));
  process.env.LOG_DIR = tempDir;
  process.env.PATH = originalPath;
  globalThis.fetch = originalFetch;
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  process.env.PATH = originalPath;
});

describe("metadata parse path", () => {
  test("structured yt-dlp fields are reported as structured; a missing artist sends the title down the split path", async () => {
    const { parseYtDlpMetadata } = await import("../src/utils/metadata-utils");
    expect(parseYtDlpMetadata({ track: "Song", artist: "A & B", title: "A & B - Song" }).parsePath).toBe("structured");
    const split = parseYtDlpMetadata({ title: "Artist - Song (Official Video)" });
    expect(split).toMatchObject({ parsePath: "title_split", artists: ["Artist"], track: "Song" });
  });

  test("fetchYtMetadata writes yt_metadata_parsed with the raw fields and the path taken", async () => {
    await fakeYtDlp(`cat <<'EOF'\n{"title":"Artist - Song","upload_date":"20200102"}\nEOF`);
    const { fetchYtMetadata } = await import("../src/utils/metadata-utils");
    const parsed = await fetchYtMetadata("https://youtube.com/watch?v=abcdefghijk", { jobId: "yt-job", youtubeId: "abcdefghijk" });
    expect(parsed).toMatchObject({ parsePath: "title_split", artists: ["Artist"], track: "Song" });
    const parsedRecords = (await records()).filter((r) => r.event === "yt_metadata_parsed");
    expect(parsedRecords).toHaveLength(1);
    expect(parsedRecords[0]).toMatchObject({
      jobId: "yt-job",
      youtubeId: "abcdefghijk",
      parsePath: "title_split",
      rawTitle: "Artist - Song",
      rawTrack: null,
      rawArtist: null,
      parsedTrack: "Song",
      parsedArtists: ["Artist"],
    });
  });
});

describe("MusicBrainz query and raw response", () => {
  test("the query is logged to the file and the raw body is saved before parsing, under the lookup id", async () => {
    const body = JSON.stringify({ count: 1, recordings: [{ id: "rec-1", score: "92", title: "T" }] });
    globalThis.fetch = (async () => response(body)) as unknown as typeof fetch;
    const { fetchMusicBrainzMetadata } = await import("../src/utils/metadata-utils");
    await fetchMusicBrainzMetadata(
      { artists: ["A"], album: "Al", track: "T" },
      { jobId: "mb-job", youtubeId: "yt-mb", musicbrainzLookupId: "lookup-1" },
    );

    const query = (await records()).find((r) => r.event === "musicbrainz_query_sent");
    expect(query).toMatchObject({ level: "info", jobId: "mb-job", youtubeId: "yt-mb", musicbrainzLookupId: "lookup-1", query: `recording:"T" AND release:"Al" AND artist:"A"` });
    expect(query.encodedQuery).toContain("T");

    expect(await readFile(join(tempDir, "musicbrainz", "lookup-1.json"), "utf8")).toBe(body);
    const timing = (await records()).find((r) => r.service === "musicbrainz");
    expect(timing).toMatchObject({ outcome: "ok", musicbrainzLookupId: "lookup-1" });
  });

  test("a body that fails to parse is still saved, and the failure carries the same lookup id", async () => {
    globalThis.fetch = (async () => response("<html>upstream error</html>")) as unknown as typeof fetch;
    const { fetchMusicBrainzMetadata } = await import("../src/utils/metadata-utils");
    await expect(
      fetchMusicBrainzMetadata({ artists: [], album: null, track: "x" }, { musicbrainzLookupId: "lookup-bad" }),
    ).rejects.toThrow();

    expect(await readFile(join(tempDir, "musicbrainz", "lookup-bad.json"), "utf8")).toBe("<html>upstream error</html>");
    const timing = (await records()).find((r) => r.service === "musicbrainz");
    expect(timing).toMatchObject({ outcome: "error", errorKind: "malformed_json", musicbrainzLookupId: "lookup-bad" });
  });

  test("a lookup without an id gets one, and its response file is named after it", async () => {
    globalThis.fetch = (async () => response(JSON.stringify({ recordings: [] }))) as unknown as typeof fetch;
    const { fetchMusicBrainzMetadata } = await import("../src/utils/metadata-utils");
    await fetchMusicBrainzMetadata({ artists: [], album: null, track: "x" });

    const timing = (await records()).find((r) => r.service === "musicbrainz");
    expect(timing.musicbrainzLookupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(join(tempDir, "musicbrainz", `${timing.musicbrainzLookupId}.json`), "utf8")).toBe(JSON.stringify({ recordings: [] }));
  });

  test("a response file that cannot be written is logged as a warning and does not fail the lookup", async () => {
    // A regular file where the musicbrainz/ directory should go makes the write fail.
    await writeFile(join(tempDir, "musicbrainz"), "not a directory");
    globalThis.fetch = (async () => response(JSON.stringify({ recordings: [] }))) as unknown as typeof fetch;
    const { fetchMusicBrainzMetadata } = await import("../src/utils/metadata-utils");
    await expect(
      fetchMusicBrainzMetadata({ artists: [], album: null, track: "x" }, { musicbrainzLookupId: "lookup-nowrite" }),
    ).resolves.toEqual({ recordings: [] });

    const warning = (await records()).find((r) => r.event === "musicbrainz_response_save_failed");
    expect(warning).toMatchObject({ level: "warning", musicbrainzLookupId: "lookup-nowrite" });
    expect(warning).not.toHaveProperty("musicbrainzResponseFile");
  });

  test("a non-OK MusicBrainz response saves its body as an error artifact, and the failure record references it", async () => {
    const body = "<html>Service Unavailable</html>";
    globalThis.fetch = (async () => new Response(body, { status: 503, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const { fetchMusicBrainzMetadata } = await import("../src/utils/metadata-utils");
    await expect(
      fetchMusicBrainzMetadata({ artists: [], album: null, track: "x" }, { musicbrainzLookupId: "lookup-503" }),
    ).rejects.toThrow("Request failed: 503");

    expect(await readFile(join(tempDir, "musicbrainz", "lookup-503.error.txt"), "utf8")).toBe(body);
    await expect(readFile(join(tempDir, "musicbrainz", "lookup-503.json"), "utf8")).rejects.toThrow();
    const timing = (await records()).find((r) => r.service === "musicbrainz");
    expect(timing).toMatchObject({
      outcome: "error",
      status: 503,
      musicbrainzLookupId: "lookup-503",
      errorResponseFile: "musicbrainz/lookup-503.error.txt",
      errorResponseBytes: Buffer.byteLength(body),
      errorResponseTruncated: false,
    });
  });

  test("an error body over the cap is saved truncated and the record says so", async () => {
    const body = "e".repeat(300 * 1024);
    globalThis.fetch = (async () => new Response(body, { status: 503 })) as unknown as typeof fetch;
    const { fetchMusicBrainzMetadata } = await import("../src/utils/metadata-utils");
    await expect(
      fetchMusicBrainzMetadata({ artists: [], album: null, track: "x" }, { musicbrainzLookupId: "lookup-big" }),
    ).rejects.toThrow("Request failed: 503");

    expect((await readFile(join(tempDir, "musicbrainz", "lookup-big.error.txt"), "utf8")).length).toBe(256 * 1024);
    const timing = (await records()).find((r) => r.service === "musicbrainz");
    expect(timing).toMatchObject({ errorResponseBytes: 256 * 1024, errorResponseTruncated: true });
  });
});

describe("MusicBrainz match selection", () => {
  test("the picked recording, its score, artist credit and the candidate count are written to the file", async () => {
    const { logMusicBrainzMatchSelected } = await import("../src/utils/metadata-utils");
    await logMusicBrainzMatchSelected(
      {
        count: 7,
        recordings: [
          { id: "rec-top", score: 61, title: "Song", "artist-credit": [{ name: "Artist A" }, { name: "Artist B" }] },
          { id: "rec-second", score: 40, title: "Song", "artist-credit": [{ name: "Other" }] },
        ],
      },
      { jobId: "pick-job", youtubeId: "pick-yt", musicbrainzLookupId: "lookup-pick" },
    );

    const selected = (await records()).find((r) => r.event === "musicbrainz_match_selected");
    expect(selected).toMatchObject({
      level: "info",
      jobId: "pick-job",
      youtubeId: "pick-yt",
      musicbrainzLookupId: "lookup-pick",
      candidateCount: 2,
      totalCount: 7,
      selectedRecordingId: "rec-top",
      selectedTitle: "Song",
      score: 61,
      artistCredit: ["Artist A", "Artist B"],
    });
  });

  test("no recordings is recorded as a null selection, not an error", async () => {
    const { logMusicBrainzMatchSelected } = await import("../src/utils/metadata-utils");
    await logMusicBrainzMatchSelected({ count: 0, recordings: [] }, { jobId: "none-job", youtubeId: "none-yt" });

    const selected = (await records()).find((r) => r.event === "musicbrainz_match_selected" && r.jobId === "none-job");
    expect(selected).toMatchObject({ candidateCount: 0, totalCount: 0, selectedRecordingId: null, score: null, artistCredit: [] });
  });
});

describe("fallback record links to the response file", () => {
  test("metadata_fallback_selected carries the lookup id and response file when MusicBrainz had no recording", async () => {
    const { extractRecordingAndRelease, musicbrainzResponseFileFor } = await import("../src/utils/metadata-utils");
    const yt = { artists: ["A"], album: "Al", track: "T", upload_date: "2020-01-01", parsePath: "structured" as const };
    await extractRecordingAndRelease({ recordings: [] }, yt, {
      jobId: "fb-job",
      youtubeId: "fb-yt",
      musicbrainzLookupId: "lookup-fb",
      musicbrainzResponseFile: musicbrainzResponseFileFor("lookup-fb"),
    });

    const fallback = (await records()).find((r) => r.event === "metadata_fallback_selected");
    expect(fallback).toMatchObject({
      jobId: "fb-job",
      reason: "no_musicbrainz_recording",
      musicbrainzLookupId: "lookup-fb",
      musicbrainzResponseFile: "musicbrainz/lookup-fb.json",
    });
  });
});

describe("committed track record", () => {
  test("database_transaction_committed is in the file with the track row id and MusicBrainz ids", async () => {
    // Runs in a child process with its own DB_FILE_NAME, so the test never
    // touches the real tracks.sqlite (the DB module is a per-process singleton).
    const databasePath = join(tempDir, "test.sqlite");
    const probe = join(tempDir, "probe.ts");
    const addNewTrackModule = join(process.cwd(), "src/server/db/transactions/addNewTrack.ts");
    await writeFile(
      probe,
      `import { sql } from "drizzle-orm";
const { db } = await import(${JSON.stringify(join(process.cwd(), "src/server/db/index.ts"))});
const { addNewTrack } = await import(${JSON.stringify(addNewTrackModule)});
await db.run(sql\`CREATE TABLE release_groups_table (id text PRIMARY KEY NOT NULL, musicbrainz_release_group_id text UNIQUE, musicbrainz_primary_type text NOT NULL, title text NOT NULL, cover_art_url text, first_release_date integer NOT NULL, cover_art_url_thumbnail_large text, cover_art_url_thumbnail_small text, created_at integer NOT NULL, updated_at integer NOT NULL)\`);
await db.run(sql\`CREATE TABLE artists_table (id text PRIMARY KEY NOT NULL, musicbrainz_id text UNIQUE, name text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)\`);
await db.run(sql\`CREATE TABLE tracks_table (id text PRIMARY KEY NOT NULL, youtube_id text NOT NULL UNIQUE, musicbrainz_recording_id text UNIQUE, release_group_id text, title text NOT NULL, first_release_date integer NOT NULL, length integer NOT NULL, file_path text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)\`);
await db.run(sql\`CREATE TABLE track_artists (track_id text, artist_id text, pos integer NOT NULL, joinphrase text)\`);
await addNewTrack({
  release: { date: "2020-05-01", "release-group": { id: "rg-committed", "primary-type": "Album", title: "Album" } },
  youtubeId: "yt-committed",
  filePath: "audio/Song.opus",
  recording: { id: "rec-committed", title: "Song", "first-release-date": "2019", length: 123, "artist-credit": [{ name: "Artist", joinphrase: "", artist: { id: "artist-committed", name: "Artist" } }] },
}, { jobId: "commit-job", musicbrainzLookupId: "lookup-commit", musicbrainzResponseFile: "musicbrainz/lookup-commit.json" });
`,
    );
    const child = Bun.spawn(["bun", probe], {
      cwd: process.cwd(),
      env: { ...process.env, DB_FILE_NAME: databasePath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const committed = (await records()).find((r) => r.event === "database_transaction_committed");
    const stored = new Database(databasePath).query("SELECT id, release_group_id FROM tracks_table WHERE youtube_id = 'yt-committed'").get() as { id: string; release_group_id: string };
    expect(committed).toMatchObject({
      level: "info",
      jobId: "commit-job",
      youtubeId: "yt-committed",
      trackId: stored.id,
      releaseGroupId: stored.release_group_id,
      musicbrainzRecordingId: "rec-committed",
      musicbrainzReleaseGroupId: "rg-committed",
      musicbrainzLookupId: "lookup-commit",
      musicbrainzResponseFile: "musicbrainz/lookup-commit.json",
      releaseDate: { raw: "2020-05-01", type: "string", parsesAsDate: true },
    });
  });
});
