import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
const databaseDir = await mkdtemp(join(tmpdir(), "sonora-date-db-"));
const databasePath = join(databaseDir, "test.sqlite");
process.env.DB_FILE_NAME = databasePath;
let tempDir: string;

function todayLog() { return join(process.env.LOG_DIR!, `ingest-${new Date().toLocaleDateString("en-CA")}.jsonl`); }
async function records() {
  try { return (await readFile(todayLog(), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
}
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function artistCredit() { return [{ name: "Artist", joinphrase: "", artist: { id: "artist-1", name: "Artist" } }]; }
function release(date = "2020-05-01", id = "rg-1") { return { date, "release-group": { id, "primary-type": "Album", title: "Album" } }; }
function recording(overrides: Record<string, unknown> = {}) { return { id: "recording-1", title: "Song", "first-release-date": "2019", length: 123, "artist-credit": artistCredit(), releases: [release()], ...overrides }; }
const yt = { artists: ["Artist"], album: "Album", track: "Song", upload_date: "20200102" };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-date-log-"));
  process.env.LOG_DIR = tempDir;
  process.env.PATH = originalPath;
  globalThis.fetch = (async () => response({ images: [{ image: "image", thumbnails: { large: "large", small: "small" } }] })) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; process.env.PATH = originalPath; });
afterAll(() => { process.env.PATH = originalPath; globalThis.fetch = originalFetch; });

describe("describeDateValue", () => {
  test("reports raw type and Date parsing without changing ordinary values", async () => {
    const { describeDateValue } = await import("../src/utils/dateLogging");
    const date = new Date("2020-05-01T00:00:00.000Z");
    expect(describeDateValue(undefined)).toEqual({ raw: null, type: "undefined", parsesAsDate: false });
    expect(describeDateValue(null)).toEqual({ raw: null, type: "object", parsesAsDate: true });
    expect(describeDateValue("")).toEqual({ raw: "", type: "string", parsesAsDate: false });
    expect(describeDateValue("2020-05-01")).toEqual({ raw: "2020-05-01", type: "string", parsesAsDate: true });
    expect(describeDateValue("2019")).toEqual({ raw: "2019", type: "string", parsesAsDate: true });
    expect(describeDateValue("not-a-date")).toEqual({ raw: "not-a-date", type: "string", parsesAsDate: false });
    expect(describeDateValue(0)).toEqual({ raw: 0, type: "number", parsesAsDate: true });
    expect(describeDateValue(date)).toEqual({ raw: date, type: "object", parsesAsDate: true });
  });
  test.each([1n, Symbol("date"), () => "date"])("preserves the raw non-JSON date-like value %#", async (value) => {
    const { describeDateValue } = await import("../src/utils/dateLogging");
    expect(describeDateValue(value).raw).toBe(value);
  });
});

describe("release date selection logging", () => {
  async function extract(metadata: unknown, metadataYt = yt) {
    const { extractRecordingAndRelease } = await import("../src/utils/metadata-utils");
    return extractRecordingAndRelease(metadata, metadataYt as any, { jobId: "job", youtubeId: "youtube" });
  }
  async function selected() { return (await records()).filter((r) => r.event === "release_date_selected"); }
  test("logs complete MusicBrainz selection once with sources and count", async () => {
    await extract({ recordings: [recording({ releases: [release("2020-05-01"), { date: null }] })] });
    const events = await selected(); expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ jobId: "job", youtubeId: "youtube", stage: "metadata_reconciliation", releaseDateSource: "musicbrainz_release", recordingDateSource: "musicbrainz_recording", usedPlaceholderRelease: false, releaseCount: 2, releaseDate: { raw: "2020-05-01", type: "string", parsesAsDate: true }, recordingFirstReleaseDate: { raw: "2019", type: "string", parsesAsDate: true } });
    expect((await records()).filter((r) => r.event === "musicbrainz_release_incomplete")).toHaveLength(0);
  });
  test("logs missing and empty MusicBrainz recording dates as missing", async () => {
    await extract({ recordings: [recording({ "first-release-date": undefined })] });
    let event = (await selected())[0]; expect(event).toMatchObject({ recordingDateSource: "missing", recordingFirstReleaseDate: { raw: null, type: "undefined", parsesAsDate: false } });
    process.env.LOG_DIR = await mkdtemp(join(tmpdir(), "sonora-date-empty-"));
    await extract({ recordings: [recording({ "first-release-date": "" })] });
    event = (await selected())[0]; expect(event).toMatchObject({ recordingDateSource: "missing", recordingFirstReleaseDate: { raw: "", type: "string", parsesAsDate: false } });
  });
  test("logs placeholder selection and enriched incomplete warning", async () => {
    await extract({ recordings: [recording({ id: "recording-x", releases: [{ date: null }] })] });
    const rs = await records(); const event = rs.find((r) => r.event === "release_date_selected"); const warning = rs.find((r) => r.event === "musicbrainz_release_incomplete");
    expect(event).toMatchObject({ releaseDateSource: "placeholder", recordingDateSource: "musicbrainz_recording", usedPlaceholderRelease: true, releaseCount: 1, releaseDate: { raw: 0, type: "number", parsesAsDate: true } });
    expect(warning).toMatchObject({ releaseCount: 1, recordingId: "recording-x" });
  });
  test("uses null recordingId for an incomplete anonymous recording", async () => {
    await extract({ recordings: [recording({ id: undefined, releases: [] })] });
    expect((await records()).find((r) => r.event === "musicbrainz_release_incomplete")).toMatchObject({ recordingId: null, releaseCount: 0 });
  });
  test("logs upload-date fallback without releaseCount or incomplete warning", async () => {
    await extract({ recordings: [] }); const event = (await selected())[0];
    expect(event).toMatchObject({ releaseDateSource: "upload_date", recordingDateSource: "upload_date", usedPlaceholderRelease: false, releaseDate: { raw: "20200102", type: "string", parsesAsDate: false }, recordingFirstReleaseDate: { raw: "20200102", type: "string", parsesAsDate: false } });
    expect(Object.hasOwn(event, "releaseCount")).toBe(false); expect((await records()).filter((r) => r.event === "musicbrainz_release_incomplete")).toHaveLength(0);
  });
  test("logs today fallback without releaseCount and preserves today's stored values", async () => {
    const [rec, rel] = await extract({ recordings: [] }, { ...yt, upload_date: null } as any); const event = (await selected())[0]; const today = new Date().toISOString().slice(0, 10);
    expect(event).toMatchObject({ releaseDateSource: "today", recordingDateSource: "today", usedPlaceholderRelease: false, releaseDate: { raw: today, type: "string", parsesAsDate: true }, recordingFirstReleaseDate: { raw: today, type: "string", parsesAsDate: true } });
    expect(Object.hasOwn(event, "releaseCount")).toBe(false); expect(rec["first-release-date"]).toBe(today); expect(rel.date).toBe(today);
  });
});

describe("database transaction failure logging", () => {
  function createTables() {
    const sql = new Database(databasePath);
    sql.exec("DROP TABLE IF EXISTS track_artists; DROP TABLE IF EXISTS tracks_table; DROP TABLE IF EXISTS artists_table; DROP TABLE IF EXISTS release_groups_table; CREATE TABLE release_groups_table (id TEXT PRIMARY KEY, musicbrainz_release_group_id TEXT UNIQUE, musicbrainz_primary_type TEXT NOT NULL, title TEXT NOT NULL, cover_art_url TEXT, first_release_date INTEGER NOT NULL, cover_art_url_thumbnail_large TEXT, cover_art_url_thumbnail_small TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE tracks_table (id TEXT PRIMARY KEY, youtube_id TEXT NOT NULL UNIQUE, musicbrainz_recording_id TEXT UNIQUE, release_group_id TEXT, title TEXT NOT NULL, first_release_date INTEGER NOT NULL, length INTEGER NOT NULL, file_path TEXT NOT NULL, disc_number integer, track_number integer, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE artists_table (id TEXT PRIMARY KEY, musicbrainz_id TEXT UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE track_artists (track_id TEXT, artist_id TEXT, pos INTEGER NOT NULL, joinphrase TEXT);"); sql.close();
  }
  async function add(info: Record<string, any>) { const { addNewTrack } = await import("../src/server/db/transactions/addNewTrack"); return addNewTrack(info as any, { jobId: "db-job" }); }
  function valid(youtubeId: string) { return { youtubeId, filePath: "audio/x.opus", release: release("2020-05-01", `rg-${youtubeId}`), recording: recording({ id: `rec-${youtubeId}`, releases: undefined }) }; }
  test("logs date descriptions for NOT NULL, invalid empty release date, valid-date conflict, and no record on success", async () => {
    createTables(); const noRecordingDate = valid("not-null"); (noRecordingDate.recording as any)["first-release-date"] = undefined;
    await expect(add(noRecordingDate)).rejects.toThrow(); let failures = (await records()).filter((r) => r.event === "database_transaction_failed");
    expect(failures.at(-1)).toMatchObject({ recordingFirstReleaseDate: { raw: null, type: "undefined", parsesAsDate: false }, releaseDate: { raw: "2020-05-01", type: "string", parsesAsDate: true } });
    const badRelease = valid("empty-release"); badRelease.release.date = ""; await expect(add(badRelease)).rejects.toThrow(); failures = (await records()).filter((r) => r.event === "database_transaction_failed");
    expect(failures.at(-1)).toMatchObject({ releaseDate: { raw: "", type: "string", parsesAsDate: false }, recordingFirstReleaseDate: { parsesAsDate: true } });
    const good = valid("duplicate"); await expect(add(good)).resolves.toBeUndefined(); const before = (await records()).filter((r) => r.event === "database_transaction_failed").length;
    const conflict = valid("duplicate"); conflict.recording.id = "rec-conflict"; conflict.release["release-group"].id = "rg-conflict"; await expect(add(conflict)).rejects.toThrow(); failures = (await records()).filter((r) => r.event === "database_transaction_failed");
    expect(failures).toHaveLength(before + 1); expect(failures.at(-1)).toMatchObject({ recordingFirstReleaseDate: { parsesAsDate: true }, releaseDate: { parsesAsDate: true } });
    const { extractRecordingAndRelease } = await import("../src/utils/metadata-utils");
    const [placeholderRecording, placeholderRelease] = await extractRecordingAndRelease({ recordings: [recording({ releases: [] })] }, yt as any, { jobId: "db-job", youtubeId: "placeholder-store" });
    await expect(add({ youtubeId: "placeholder-store", filePath: "audio/placeholder.opus", release: placeholderRelease, recording: placeholderRecording })).resolves.toBeUndefined();
    const sql = new Database(databasePath); expect(sql.query("SELECT first_release_date FROM release_groups_table WHERE title = 'Unknown Album'").get()).toMatchObject({ first_release_date: 0 }); sql.close();
  });
});

describe("ingest boundaries and stage output", () => {
  async function fakeYtDlp(script: string) { const bin = join(tempDir, "bin"); await mkdir(bin, { recursive: true }); await writeFile(join(bin, "yt-dlp"), `#!/bin/sh\n${script}\n`); await chmod(join(bin, "yt-dlp"), 0o755); process.env.PATH = `${bin}:${originalPath}`; }
  test("failed MusicBrainz lookup has no selected release event", async () => {
    await fakeYtDlp("echo '{\"title\":\"Artist - Song\",\"upload_date\":\"20200102\"}'"); globalThis.fetch = (async () => response({}, 503)) as unknown as typeof fetch;
    const { ingestTrack } = await import("../src/services/ingestTrack"); await expect(ingestTrack("https://youtube.com/watch?v=abcdefghijk", "lookup-fail")).rejects.toThrow();
    expect((await records()).filter((r) => r.event === "release_date_selected")).toHaveLength(0);
  });
  test("metadata reconciliation completion includes selected release information", async () => {
    await fakeYtDlp("echo '{\"title\":\"Artist - Song\",\"upload_date\":\"20200102\"}'; exit 0");
    globalThis.fetch = (async (url: string) => url.includes("musicbrainz") ? response({ recordings: [recording({ id: "stage-recording", releases: [{ date: null }] })] }) : response({ images: [] })) as unknown as typeof fetch;
    const lines: string[] = []; const log = console.log; console.log = (...args: any[]) => { lines.push(args.join(" ")); };
    try { const { ingestTrack } = await import("../src/services/ingestTrack"); await ingestTrack("https://youtube.com/watch?v=abcdefghijk", "stage-job"); } finally { console.log = log; }
    const stage = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((record) => record?.event === "ingest_stage_completed" && record?.stage === "metadata_reconciliation");
    expect(stage).toMatchObject({ usedPlaceholderRelease: true, releaseDateSource: "placeholder" });
  });
});
