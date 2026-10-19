import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
let tempDir: string;

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
function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
function coverRelease(id = "rg-1") {
  return {
    date: "2020-01-01",
    "release-group": { id, "primary-type": "Album", title: "Album" },
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-external-call-log-"));
  process.env.LOG_DIR = tempDir;
  delete process.env.EXTERNAL_CALL_SLOW_MS;
  delete process.env.EXTERNAL_FETCH_TIMEOUT_MS;
  globalThis.fetch = originalFetch;
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  process.env.PATH = originalPath;
  delete process.env.EXTERNAL_CALL_SLOW_MS;
  delete process.env.EXTERNAL_FETCH_TIMEOUT_MS;
});

describe("slow external call watchdog", () => {
  test("a call still pending past the threshold logs external_call_slow before it finishes", async () => {
    const { logExternalCall } = await import("../src/utils/ingestLogger");
    process.env.EXTERNAL_CALL_SLOW_MS = "20";
    const result = await logExternalCall(
      { service: "slow_probe", jobId: "s1" },
      () =>
        new Promise<string>((resolve) => setTimeout(() => resolve("done"), 80)),
    );
    expect(result).toBe("done");

    const rs = (await records()).filter((r) => r.service === "slow_probe");
    expect(rs.map((r) => r.event)).toEqual([
      "external_call_slow",
      "external_call_finished",
    ]);
    expect(rs[0]).toMatchObject({
      level: "info",
      jobId: "s1",
      thresholdMs: 20,
    });
    expect(rs[0].elapsedMs).toBeGreaterThanOrEqual(20);
    expect(rs[1]).toMatchObject({ outcome: "ok", jobId: "s1" });
  });

  test("a fast call logs no slow record and the watchdog does not fire after finishing", async () => {
    const { logExternalCall } = await import("../src/utils/ingestLogger");
    process.env.EXTERNAL_CALL_SLOW_MS = "30";
    await logExternalCall({ service: "fast_probe" }, async () => "ok");
    await Bun.sleep(60);

    const rs = (await records()).filter((r) => r.service === "fast_probe");
    expect(rs.map((r) => r.event)).toEqual(["external_call_finished"]);
  });

  test("a call that throws still clears the watchdog and logs one finish record", async () => {
    const { logExternalCall } = await import("../src/utils/ingestLogger");
    process.env.EXTERNAL_CALL_SLOW_MS = "30";
    await expect(
      logExternalCall({ service: "throw_probe" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await Bun.sleep(60);

    const rs = (await records()).filter((r) => r.service === "throw_probe");
    expect(rs.map((r) => [r.event, r.outcome])).toEqual([
      ["external_call_finished", "error"],
    ]);
  });
});

describe("MusicBrainz and Cover Art attempt records", () => {
  test("MusicBrainz 503 carries url, attempt 1, Retry-After and the elapsed time", async () => {
    const { fetchMusicBrainzMetadata } =
      await import("../src/utils/metadata-utils");
    globalThis.fetch = (async () =>
      response({}, 503, { "retry-after": "120" })) as unknown as typeof fetch;
    await fetchMusicBrainzMetadata(
      { artists: [], album: null, track: "x" },
      { jobId: "mb503" },
    ).catch(() => {});

    const [attempt] = (await records()).filter(
      (r) => r.service === "musicbrainz",
    );
    expect(attempt).toMatchObject({
      event: "external_call_finished",
      outcome: "error",
      status: 503,
      retryAfter: "120",
      attempt: 1,
      host: "musicbrainz.org",
      jobId: "mb503",
      errorKind: "http_5xx",
    });
    expect(attempt.url).toContain(
      "https://musicbrainz.org/ws/2/recording?query=",
    );
    expect(typeof attempt.durationMs).toBe("number");
  });

  test("a response without Retry-After omits the field", async () => {
    const { fetchMusicBrainzMetadata } =
      await import("../src/utils/metadata-utils");
    globalThis.fetch = (async () =>
      response({ recordings: [] })) as unknown as typeof fetch;
    await fetchMusicBrainzMetadata({ artists: [], album: null, track: "x" });

    const [attempt] = (await records()).filter(
      (r) => r.service === "musicbrainz",
    );
    expect(Object.hasOwn(attempt, "retryAfter")).toBe(false);
    expect(attempt).toMatchObject({ outcome: "ok", attempt: 1 });
  });

  test("Cover Art failure carries the release-group id, url and host on the timing record", async () => {
    const { extractRecordingAndRelease } =
      await import("../src/utils/metadata-utils");
    globalThis.fetch = (async () =>
      response({}, 500, { "Retry-After": "5" })) as unknown as typeof fetch;
    await extractRecordingAndRelease(
      { recordings: [{ title: "Song", releases: [coverRelease("rg-42")] }] },
      { artists: ["A"], album: "Album", track: "Song", upload_date: "2020" },
      { jobId: "ca", youtubeId: "y" },
    );

    const [timing] = (await records()).filter((r) => r.service === "cover_art");
    expect(timing).toMatchObject({
      outcome: "error",
      status: 500,
      retryAfter: "5",
      attempt: 1,
      host: "coverartarchive.org",
      releaseGroupId: "rg-42",
      jobId: "ca",
      errorKind: "http_5xx",
    });
    expect(timing.url).toBe("https://coverartarchive.org/release-group/rg-42");
  });
});

describe("yt-dlp playlist expansion", () => {
  test("playlist expansion writes one external_call_finished record with its elapsed time", async () => {
    const bin = join(tempDir, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "yt-dlp"),
      `#!/bin/sh\necho 'https://youtu.be/abcdefghijk'\n`,
    );
    await chmod(join(bin, "yt-dlp"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    const { getAllUrlsFromPlaylist } =
      await import("../src/utils/metadata-utils");
    const urls = await getAllUrlsFromPlaylist(
      "https://www.youtube.com/playlist?list=PL1",
      "req-1",
    );
    expect(urls).toEqual(["https://youtu.be/abcdefghijk"]);

    const [timing] = (await records()).filter(
      (r) => r.service === "yt_dlp_playlist",
    );
    expect(timing).toMatchObject({
      event: "external_call_finished",
      outcome: "ok",
      requestId: "req-1",
    });
    expect(typeof timing.durationMs).toBe("number");
  });
});
