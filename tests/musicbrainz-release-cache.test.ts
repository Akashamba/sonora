import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchMusicBrainzRelease,
  musicBrainzReleaseCacheSize,
} from "~/utils/metadata-utils";

const originalFetch = globalThis.fetch;
let tempDir: string;
let requestedIds: string[];

// Answers each release request with the next status queued for that id. A status
// that is missing from the queue answers 200.
function answerReleases(statusesById: Record<string, number[]>) {
  requestedIds = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const id = decodeURIComponent(url.match(/\/release\/([^?]+)/)![1]!);
    requestedIds.push(id);
    const queue = statusesById[id] ?? [];
    const status = queue.length > 0 ? queue.shift()! : 200;
    const body =
      status === 200 ? JSON.stringify({ id, media: [] }) : "not found";
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-mb-release-cache-"));
  process.env.LOG_DIR = tempDir;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(tempDir, { recursive: true, force: true });
});

describe("fetchMusicBrainzRelease cache", () => {
  test("a failed lookup is not cached, so a later job retries it", async () => {
    answerReleases({ "rel-fail-1": [404] });

    await expect(fetchMusicBrainzRelease("rel-fail-1")).rejects.toThrow();
    const retried = await fetchMusicBrainzRelease("rel-fail-1");

    expect(retried).toMatchObject({ id: "rel-fail-1" });
    expect(requestedIds).toEqual(["rel-fail-1", "rel-fail-1"]);
  });

  test("a successful lookup is shared by later calls for the same release", async () => {
    answerReleases({});

    await fetchMusicBrainzRelease("rel-shared");
    await fetchMusicBrainzRelease("rel-shared");

    expect(requestedIds).toEqual(["rel-shared"]);
  });

  test("the cache is capped at 50 entries", async () => {
    answerReleases({});

    for (let i = 0; i < 60; i++) {
      await fetchMusicBrainzRelease(`rel-cap-${i}`);
    }

    expect(musicBrainzReleaseCacheSize()).toBeLessThanOrEqual(50);
    // The oldest entry was evicted, so asking again goes back to the network.
    requestedIds = [];
    await fetchMusicBrainzRelease("rel-cap-0");
    expect(requestedIds).toEqual(["rel-cap-0"]);
  }, 20000);
});
