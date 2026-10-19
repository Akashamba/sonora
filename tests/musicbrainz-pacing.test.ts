import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchMusicBrainzMetadata } from "~/utils/metadata-utils";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-mb-pacing-"));
  process.env.LOG_DIR = tempDir;
  process.env.MUSICBRAINZ_MIN_INTERVAL_MS = "1500";
  globalThis.fetch = originalFetch;
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  process.env.MUSICBRAINZ_MIN_INTERVAL_MS = "0";
});

describe("MusicBrainz request pacing", () => {
  test("concurrent lookups are sent at least 1.5 seconds apart", async () => {
    const sentAt: number[] = [];
    globalThis.fetch = (async () => {
      sentAt.push(Date.now());
      return new Response(JSON.stringify({ count: 0, recordings: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const metadata = { artists: ["Artist"], album: null, track: "Track" };
    await Promise.all([
      fetchMusicBrainzMetadata(metadata),
      fetchMusicBrainzMetadata(metadata),
    ]);

    expect(sentAt).toHaveLength(2);
    expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(1490);
  });
});
