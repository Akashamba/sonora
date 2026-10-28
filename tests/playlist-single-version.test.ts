import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_FILE_NAME = join(
  await mkdtemp(join(tmpdir(), "sonora-single-version-db-")),
  "test.sqlite",
);
const {
  extractRecordingAndRelease,
  fetchMusicBrainzMetadata,
  scoreRecordingCandidates,
  selectReleaseForMode,
} = await import("../src/utils/metadata-utils");

const originalFetch = globalThis.fetch;
let tempDir: string;
// Each MusicBrainz call waits for the one-second pacing slot.
const PACED_TEST_TIMEOUT_MS = 20000;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-single-version-"));
  process.env.LOG_DIR = tempDir;
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

function respondByUrl(handler: (url: string) => unknown) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = decodeURIComponent(String(input));
    urls.push(url);
    return new Response(JSON.stringify(handler(url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return urls;
}

const albumRelease = {
  id: "album",
  date: "2009-07-06",
  title: "Lungs",
  status: "Official",
  "release-group": { id: "rg-album", title: "Lungs", "primary-type": "Album" },
};
const singleRelease = {
  id: "single",
  date: "2009-12-21",
  title: "Dog Days Are Over",
  status: "Official",
  "release-group": {
    id: "rg-single",
    title: "Dog Days Are Over",
    "primary-type": "Single",
  },
};

describe("playlist mode picks the single version", () => {
  test("a live recording ranked first by MusicBrainz loses unless the video title says live", () => {
    const input = {
      track: "Song",
      artists: ["Artist"],
      album: null,
      durationMs: 200000,
    };
    const recordings = [
      {
        id: "live",
        title: "Song",
        length: 200000,
        score: 100,
        disambiguation: "live, 2012-05-01: Glastonbury",
        "artist-credit": [{ name: "Artist" }],
        releases: [albumRelease],
      },
      {
        id: "studio",
        title: "Song",
        length: 201000,
        score: 95,
        disambiguation: "radio edit",
        "artist-credit": [{ name: "Artist" }],
        releases: [singleRelease],
      },
    ];
    expect(scoreRecordingCandidates(recordings, input)[0]?.id).toBe("studio");
    // Recording titles must match exactly, so this live copy carries the word in its title.
    const liveTitled = recordings.map((r) => ({ ...r, title: "Song (Live)" }));
    expect(
      scoreRecordingCandidates(liveTitled, { ...input, track: "Song (Live)" })[0]
        ?.id,
    ).toBe("live");
    expect(
      scoreRecordingCandidates(recordings, input, { preferStudio: true })[0]
        ?.id,
    ).toBe("studio");
  });

  test("YouTube's album tag does not outrank the single in playlist mode", () => {
    const recording = { releases: [albumRelease, singleRelease] };
    expect(selectReleaseForMode(recording, "single", "Lungs").id).toBe("album");
    expect(selectReleaseForMode(recording, "playlist", "Lungs").id).toBe(
      "single",
    );
  });

  test(
    "a title with a trailing version note is searched again without it",
    async () => {
      const urls = respondByUrl((url) =>
        url.includes("2010 Version")
          ? { count: 0, recordings: [] }
          : {
              count: 1,
              recordings: [
                {
                  id: "dog-days",
                  title: "Dog Days Are Over",
                  score: 100,
                  "artist-credit": [{ name: "Florence + the Machine" }],
                },
              ],
            },
      );
      const result = await fetchMusicBrainzMetadata({
        track: "Dog Days Are Over (2010 Version)",
        artists: ["Florence + the Machine"],
        album: null,
      });
      expect(urls).toHaveLength(2);
      expect(urls[1]).not.toContain("2010 Version");
      expect(result.recordings?.[0]?.id).toBe("dog-days");
    },
    PACED_TEST_TIMEOUT_MS,
  );

  test(
    "playlist mode looks up every release of the recording to find the single",
    async () => {
      const urls = respondByUrl(() => ({
        id: "dog-days",
        releases: [albumRelease, singleRelease],
      }));
      const [, release] = await extractRecordingAndRelease(
        {
          recordings: [
            {
              id: "dog-days",
              title: "Dog Days Are Over",
              "artist-credit": [{ name: "Florence + the Machine" }],
              releases: [albumRelease],
            },
          ],
        },
        {
          track: "Dog Days Are Over",
          artists: ["Florence + the Machine"],
          album: "Lungs",
          upload_date: "20091221",
        } as any,
        { jobId: "job", youtubeId: "yt", releaseMode: "playlist" },
      );
      expect(urls.some((url) => url.includes("/ws/2/recording/dog-days"))).toBe(
        true,
      );
      expect(release.id).toBe("single");
    },
    PACED_TEST_TIMEOUT_MS,
  );
});
