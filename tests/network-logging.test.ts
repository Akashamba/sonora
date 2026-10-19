import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function coverRelease(id = "rg-1") {
  return { date: "2020-01-01", "release-group": { id, "primary-type": "Album", title: "Album" } };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-network-log-"));
  process.env.LOG_DIR = tempDir;
  process.env.DB_FILE_NAME = join(tempDir, "test.sqlite");
  delete process.env.EXTERNAL_FETCH_TIMEOUT_MS;
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.PATH = originalPath;
  delete process.env.EXTERNAL_FETCH_TIMEOUT_MS;
});

describe("network classifier", () => {
  test("classifies every kind and rejects non-network inputs", async () => {
    const { classifyNetworkError } = await import("../src/utils/networkErrors");
    const cases: Array<[unknown, ReturnType<typeof classifyNetworkError>]> = [
      [Object.assign(new Error("timed out"), { name: "TimeoutError" }), "timeout"],
      [new Error("ERROR: [youtube] abc: Unable to download API page: ... Failed to resolve 'www.youtube.com' ([Errno -3] Temporary failure in name resolution)"), "dns"],
      [Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }), "unreachable"],
      [Object.assign(new TypeError("The socket connection was closed unexpectedly"), { code: "ECONNRESET" }), "connection_reset"],
      [Object.assign(new Error("no"), { status: 403 }), "http_403"],
      [new Error("HTTP Error 429"), "http_429"],
      [Object.assign(new Error("no"), { status: 503 }), "http_5xx"],
      [Object.assign(new Error("not found"), { status: 404 }), undefined],
      [Object.assign(new Error("NOT NULL constraint failed"), { name: "SQLiteError", code: "SQLITE_CONSTRAINT_NOTNULL" }), undefined],
      [Object.assign(new Error("database is locked"), { name: "SQLiteError", code: "SQLITE_BUSY" }), undefined],
      [new Error("ordinary failure"), undefined], ["a string", undefined], [null, undefined], [undefined, undefined],
    ];
    for (const [error, expected] of cases) expect(classifyNetworkError(error)).toBe(expected);
  });
});

describe("MusicBrainz external calls", () => {
  test("success, HTTP 503, and refused fetch carry correct details and exactly one timing record", async () => {
    const { fetchMusicBrainzMetadata } = await import("../src/utils/metadata-utils");
    globalThis.fetch = (async () => response({ recordings: [] })) as unknown as typeof fetch;
    await expect(fetchMusicBrainzMetadata({ artists: ["A"], album: null, track: "T" }, { jobId: "ok", youtubeId: "yt" })).resolves.toEqual({ recordings: [] });
    let calls = (await records()).filter((r) => r.service === "musicbrainz");
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ event: "external_call_finished", outcome: "ok", host: "musicbrainz.org", jobId: "ok", youtubeId: "yt" }); expect(calls[0].errorKind).toBeUndefined(); expect(typeof calls[0].durationMs).toBe("number");
    globalThis.fetch = (async () => response({}, 503)) as unknown as typeof fetch;
    const httpError: any = await fetchMusicBrainzMetadata({ artists: [], album: null, track: "x" }).catch((e) => e);
    expect(httpError).toMatchObject({ service: "musicbrainz", host: "musicbrainz.org", status: 503, message: "Request failed: 503" }); expect(httpError.url).toContain("musicbrainz.org");
    globalThis.fetch = (async () => { throw Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" }); }) as unknown as typeof fetch;
    const refused: any = await fetchMusicBrainzMetadata({ artists: [], album: null, track: "x" }).catch((e) => e);
    expect(refused).toMatchObject({ service: "musicbrainz", code: "ConnectionRefused" }); expect(refused.status).toBeUndefined(); expect(refused.cause).toBeInstanceOf(TypeError);
    calls = (await records()).filter((r) => r.service === "musicbrainz");
    // The 503 is retried up to four attempts; the refused fetch is not retried.
    expect(calls).toHaveLength(6); expect(calls.slice(1).map((r) => [r.outcome, r.status, r.errorKind])).toEqual([["error", 503, "http_5xx"], ["error", 503, "http_5xx"], ["error", 503, "http_5xx"], ["error", 503, "http_5xx"], ["error", undefined, "unreachable"]]);
  });

  test("timeout is read per call and default timeout permits a fast response", async () => {
    const { fetchMusicBrainzMetadata } = await import("../src/utils/metadata-utils");
    process.env.EXTERNAL_FETCH_TIMEOUT_MS = "50";
    globalThis.fetch = ((_: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })))) ) as unknown as typeof fetch;
    await expect(fetchMusicBrainzMetadata({ artists: [], album: null, track: "x" })).rejects.toThrow();
    process.env.EXTERNAL_FETCH_TIMEOUT_MS = "not-a-number";
    globalThis.fetch = (async () => response({ recordings: [] })) as unknown as typeof fetch;
    await expect(fetchMusicBrainzMetadata({ artists: [], album: null, track: "x" })).resolves.toEqual({ recordings: [] });
    process.env.EXTERNAL_FETCH_TIMEOUT_MS = "0";
    globalThis.fetch = ((_: string, init: RequestInit) => new Promise((resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("unexpected abort")));
      setTimeout(() => resolve(response({ recordings: [] })), 10);
    })) as unknown as typeof fetch;
    await expect(fetchMusicBrainzMetadata({ artists: [], album: null, track: "x" })).resolves.toEqual({ recordings: [] });
    const calls = (await records()).filter((r) => r.service === "musicbrainz");
    // A timeout is retried, so the first lookup uses all four attempts.
    expect(calls.map((r) => [r.outcome, r.errorKind])).toEqual([["error", "timeout"], ["error", "timeout"], ["error", "timeout"], ["error", "timeout"], ["ok", undefined], ["ok", undefined]]);
  });
});

describe("cover art logging", () => {
  test("404 has releaseGroupId and no errorKind; 500 and refused are classified", async () => {
    const { extractRecordingAndRelease } = await import("../src/utils/metadata-utils");
    const yt = { artists: ["A"], album: "Album", track: "Song", upload_date: "2020" };
    for (const action of [
      () => response({}, 404), () => response({}, 500),
      () => { throw Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" }); },
    ]) {
      globalThis.fetch = (async () => action()) as unknown as typeof fetch;
      await extractRecordingAndRelease({ recordings: [{ title: "Song", releases: [coverRelease()] }] }, yt, { jobId: "j", youtubeId: "y" });
    }
    const rs = await records(); const warnings = rs.filter((r) => r.event === "cover_art_lookup_failed"); const timings = rs.filter((r) => r.service === "cover_art");
    expect(warnings).toHaveLength(3); expect(warnings.map((r) => [r.releaseGroupId, r.errorKind])).toEqual([["rg-1", undefined], ["rg-1", "http_5xx"], ["rg-1", "unreachable"]]);
    expect(timings).toHaveLength(3); expect(timings.map((r) => [r.outcome, r.status, r.errorKind])).toEqual([["error", 404, undefined], ["error", 500, "http_5xx"], ["error", undefined, "unreachable"]]);
  });

  test("success writes one timing record and no warning", async () => {
    const { extractRecordingAndRelease } = await import("../src/utils/metadata-utils");
    globalThis.fetch = (async () => response({ images: [{ image: "i", thumbnails: { large: "l", small: "s" } }] })) as unknown as typeof fetch;
    await extractRecordingAndRelease({ recordings: [{ title: "Song", releases: [coverRelease()] }] }, { artists: [], album: null, track: "x", upload_date: "2020" }, { jobId: "j", youtubeId: "y" });
    const rs = await records(); expect(rs.filter((r) => r.event === "cover_art_lookup_failed")).toHaveLength(0); const timing = rs.filter((r) => r.service === "cover_art"); expect(timing).toHaveLength(1); expect(timing[0]).toMatchObject({ outcome: "ok", host: "coverartarchive.org" }); expect(timing[0].errorKind).toBeUndefined();
  });
});

describe("yt-dlp and ingest failures", () => {
  async function fakeYtDlp(script: string) {
    const bin = join(tempDir, "bin"); await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "yt-dlp"), `#!/bin/sh\n${script}\n`); await chmod(join(bin, "yt-dlp"), 0o755); process.env.PATH = `${bin}:${originalPath}`;
  }
  test("metadata failure gives DNS ingest_failed; invalid URL is unclassified and has no external call", async () => {
    await fakeYtDlp("echo \"ERROR: Failed to resolve host\" >&2; exit 1");
    const { ingestTrack } = await import("../src/services/ingestTrack");
    // ingestTrack looks up the YouTube id first, so the test DB needs a tracks table. The id is
    // one no other test stores, since test files can share the DB module.
    const { db } = await import("../src/server/db"); const { sql } = await import("drizzle-orm");
    db.run(sql`CREATE TABLE IF NOT EXISTS tracks_table (id TEXT PRIMARY KEY, youtube_id TEXT NOT NULL UNIQUE)`);
    await expect(ingestTrack("https://www.youtube.com/watch?v=dnsfailure1", "dns-job")).rejects.toThrow();
    await expect(ingestTrack("not youtube", "bad-job")).rejects.toThrow();
    const rs = await records(); const failed = rs.filter((r) => r.event === "ingest_failed");
    expect(failed).toHaveLength(2); expect(failed.map((r) => r.errorKind)).toEqual(["dns", undefined]); expect(Object.hasOwn(failed[1], "errorKind")).toBe(false);
    const yt = rs.filter((r) => r.service === "yt_dlp_metadata"); expect(yt).toHaveLength(1); expect(yt[0]).toMatchObject({ outcome: "error", errorKind: "dns", jobId: "dns-job" });
  });

  test("download failed then success emits two timings and one classified warning; non-network failure has no kind", async () => {
    const counter = join(tempDir, "count");
    await fakeYtDlp(`if [ \"$1\" = \"--dump-json\" ]; then echo '{"title":"A - T","upload_date":"20200101"}'; exit 0; fi\nif [ ! -f '${counter}' ]; then touch '${counter}'; echo 'ERROR: Failed to resolve host' >&2; exit 1; fi\nexit 0`);
    const { fetchYtMetadata } = await import("../src/utils/metadata-utils"); const { downloadWithRetry } = await import("../src/utils/fetchM4a");
    await fetchYtMetadata("https://youtube.com/watch?v=abcdefghijk", { jobId: "m", youtubeId: "y" });
    await expect(downloadWithRetry("https://youtube.com/watch?v=abcdefghijk", join(tempDir, "x.m4a"), { jobId: "d", youtubeId: "y" }, 2)).resolves.toBe(2);
    const rs = await records(); const downloads = rs.filter((r) => r.service === "yt_dlp_download"); const warns = rs.filter((r) => r.event === "audio_download_attempt_failed");
    expect(downloads).toHaveLength(2); expect(downloads.map((r) => [r.attempt, r.outcome, r.errorKind])).toEqual([[1, "error", "dns"], [2, "ok", undefined]]); expect(warns).toHaveLength(1); expect(warns[0].errorKind).toBe("dns");
    await fakeYtDlp("echo 'ERROR: unsupported format' >&2; exit 1");
    await expect(downloadWithRetry("u", "f", { jobId: "n", youtubeId: "y" }, 1)).rejects.toThrow();
    const last = (await records()).filter((r) => r.event === "audio_download_attempt_failed").at(-1)!; expect(Object.hasOwn(last, "errorKind")).toBe(false);
  });

  test("malformed metadata JSON is a malformed_json error with its location, and yt-dlp HTTP 503 text is unclassified", async () => {
    await fakeYtDlp(`printf '%s' '{"title":"A - T","formats":[{"url":"x"},{"url":"y'`);
    const { fetchYtMetadata } = await import("../src/utils/metadata-utils");
    const error: any = await fetchYtMetadata("u", { jobId: "badjson" }).catch((e) => e);
    expect(error).toMatchObject({ name: "MalformedJsonError", errorKind: "malformed_json" });
    expect(error.json).toMatchObject({ path: "$.formats[1].url", line: 1 });
    expect(error.json.reason).toContain("unterminated string");
    expect(error.message).toContain("$.formats[1].url");
    let timing = (await records()).find((r) => r.service === "yt_dlp_metadata");
    expect(timing).toMatchObject({ outcome: "error", errorKind: "malformed_json", jobId: "badjson" });
    await fakeYtDlp("echo 'ERROR: HTTP Error 503' >&2; exit 1");
    const { downloadWithRetry } = await import("../src/utils/fetchM4a");
    await expect(downloadWithRetry("u", "f", { jobId: "503", youtubeId: "y" }, 1)).rejects.toThrow();
    timing = (await records()).filter((r) => r.service === "yt_dlp_download").at(-1)!;
    expect(timing).toMatchObject({ outcome: "error", jobId: "503" }); expect(Object.hasOwn(timing, "errorKind")).toBe(false);
  });
});

describe("malformed JSON location", () => {
  test("locates truncation, bad characters, empty output, and trailing content", async () => {
    const { locateJsonError } = await import("../src/utils/jsonErrors");
    expect(locateJsonError('{"a":[1,2]}')).toBeUndefined();
    expect(locateJsonError('{"a":{"b":[1,2,')).toMatchObject({ path: "$.a.b[2]", reason: "unexpected end of input, expected a value", offset: 15 });
    const bad = locateJsonError('{\n  "title": "x",\n  "duration": 12x\n}')!;
    expect(bad).toMatchObject({ path: "$", line: 3, column: 17 });
    expect(bad.reason).toBe(`unexpected character "x", expected ',' or '}'`);
    expect(bad.context).toContain("12<<HERE>>x");
    expect(locateJsonError("   ")).toMatchObject({ reason: "empty output" });
    expect(locateJsonError('{"a":1} WARNING: extra')).toMatchObject({ reason: "trailing content after the JSON value", offset: 8 });
    expect(locateJsonError('{"a":"\\q"}')!.reason).toBe("invalid escape \\q in string");
    expect(locateJsonError('{"weird key":[{"x": tru}]}')).toMatchObject({ path: '$["weird key"][0].x' });
  });

  test("a non-network error stays unclassified, and a malformed MusicBrainz body is malformed_json", async () => {
    const { errorKindFields } = await import("../src/utils/networkErrors");
    expect(errorKindFields(new SyntaxError("JSON Parse error"))).toEqual({});
    const { fetchMusicBrainzMetadata } = await import("../src/utils/metadata-utils");
    globalThis.fetch = (async () => new Response('{"recordings":[{"id":"r1",', { status: 200 })) as unknown as typeof fetch;
    const error: any = await fetchMusicBrainzMetadata({ artists: [], album: null, track: "x" }, { jobId: "mb" }).catch((e) => e);
    expect(error).toMatchObject({ errorKind: "malformed_json" });
    expect(error.json.path).toBe("$.recordings[0]");
    const timing = (await records()).find((r) => r.service === "musicbrainz");
    expect(timing).toMatchObject({ outcome: "error", status: 200, errorKind: "malformed_json" });
  });
});
