import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchMusicBrainzMetadata } from "~/utils/metadata-utils";

const originalFetch = globalThis.fetch;
let tempDir: string;

const metadata = { artists: ["Artist"], album: null, track: "Track" };
// Each attempt also waits for the one-second pacing slot, so allow for that.
const RETRY_TEST_TIMEOUT_MS = 20000;

function respondWith(statuses: number[]) {
  const calls: number[] = [];
  globalThis.fetch = (async () => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)]!;
    calls.push(status);
    const body =
      status === 200
        ? JSON.stringify({ count: 0, recordings: [] })
        : "The MusicBrainz web server is currently busy.";
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-mb-retry-"));
  process.env.LOG_DIR = tempDir;
  globalThis.fetch = originalFetch;
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

describe("MusicBrainz retries", () => {
  test(
    "a busy response is retried and the later success is returned",
    async () => {
      const calls = respondWith([503, 200]);

      const result = await fetchMusicBrainzMetadata(metadata);

      expect(calls).toEqual([503, 200]);
      expect(result.count).toBe(0);
    },
    RETRY_TEST_TIMEOUT_MS,
  );

  test(
    "a dropped connection is retried and the later success is returned",
    async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(
            new TypeError("The socket connection was closed unexpectedly"),
            { code: "ECONNRESET" },
          );
        }
        return new Response(JSON.stringify({ count: 0, recordings: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const result = await fetchMusicBrainzMetadata(metadata);

      expect(calls).toBe(2);
      expect(result.count).toBe(0);
    },
    RETRY_TEST_TIMEOUT_MS,
  );

  test(
    "a client error is not retried",
    async () => {
      const calls = respondWith([404]);

      await expect(fetchMusicBrainzMetadata(metadata)).rejects.toThrow(
        "Request failed: 404",
      );
      expect(calls).toEqual([404]);
    },
    RETRY_TEST_TIMEOUT_MS,
  );

  test(
    "gives up after four attempts",
    async () => {
      const calls = respondWith([503]);

      await expect(fetchMusicBrainzMetadata(metadata)).rejects.toThrow(
        "Request failed: 503",
      );
      expect(calls).toEqual([503, 503, 503, 503]);
    },
    RETRY_TEST_TIMEOUT_MS,
  );
});
