import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Album mode must keep the release the user chose, even when MusicBrainz left out its
// date. The cover-art lookup is stubbed so nothing leaves the machine.
const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-album-date-"));
  process.env.LOG_DIR = tempDir;
  process.env.DB_FILE_NAME = join(tempDir, "unused.sqlite");
  globalThis.fetch = (async () =>
    new Response("{}", { status: 404 })) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(tempDir, { recursive: true, force: true });
});

const { extractRecordingAndRelease } =
  await import("../src/utils/metadata-utils");

function chosenRelease(
  overrides: Record<string, unknown> = {},
  groupOverrides: Record<string, unknown> = {},
) {
  return {
    id: "chosen-release",
    title: "Chosen Album",
    date: undefined,
    "release-group": {
      id: "rg-chosen",
      "primary-type": "Album",
      title: "Chosen Album",
      "first-release-date": undefined,
      ...groupOverrides,
    },
    ...overrides,
  };
}

function recordingWith(
  releases: any[],
  firstReleaseDate: string | null = "2001-02-03",
) {
  return {
    recordings: [
      {
        id: "rec-1",
        title: "Song",
        length: 180000,
        "first-release-date": firstReleaseDate,
        "artist-credit": [
          {
            name: "Artist",
            joinphrase: "",
            artist: { id: "artist-1", name: "Artist" },
          },
        ],
        releases,
      },
    ],
  };
}

const ytMetadata = {
  artists: ["Artist"],
  track: "Song",
  album: "Chosen Album",
  upload_date: "2011-02-03",
  durationMs: 180000,
};
const albumContext = {
  jobId: "job-1",
  youtubeId: "abcdefghijk",
  releaseMode: "album" as const,
  releaseId: "chosen-release",
};

describe("album mode keeps the chosen release without a date", () => {
  test("fills the date from the release group first-release-date", async () => {
    const [, release, selection] = await extractRecordingAndRelease(
      recordingWith([chosenRelease({}, { "first-release-date": "1999-03" })]),
      ytMetadata,
      albumContext,
    );

    expect(release["release-group"].title).toBe("Chosen Album");
    expect(release.date).toBe("1999-03");
    expect(selection).toMatchObject({
      releaseDateSource: "release_group_first_release",
      usedPlaceholderRelease: false,
    });
  });

  test("falls back to the recording first-release-date, then the YouTube upload date", async () => {
    const [, fromRecording, recordingSelection] =
      await extractRecordingAndRelease(
        recordingWith([chosenRelease()], "2001-02-03"),
        ytMetadata,
        albumContext,
      );
    expect(fromRecording.date).toBe("2001-02-03");
    expect(recordingSelection.releaseDateSource).toBe(
      "recording_first_release",
    );

    const [, fromUpload, uploadSelection] = await extractRecordingAndRelease(
      recordingWith([chosenRelease()], null),
      ytMetadata,
      albumContext,
    );
    expect(fromUpload.date).toBe("2011-02-03");
    expect(uploadSelection).toMatchObject({
      releaseDateSource: "upload_date",
      usedPlaceholderRelease: false,
    });
  });

  test("uses the chosen release even when another complete release exists", async () => {
    const other = {
      id: "other",
      title: "Other",
      date: "1990-01-01",
      status: "Official",
      "release-group": {
        id: "rg-other",
        "primary-type": "Album",
        title: "Other",
      },
    };
    const [, release] = await extractRecordingAndRelease(
      recordingWith([other, chosenRelease()]),
      ytMetadata,
      albumContext,
    );
    expect(release.id).toBe("chosen-release");
    expect(release["release-group"].title).toBe("Chosen Album");
  });

  test("a chosen release with a date is used as-is", async () => {
    const [, release, selection] = await extractRecordingAndRelease(
      recordingWith([chosenRelease({ date: "2005-06-07" })]),
      ytMetadata,
      albumContext,
    );
    expect(release.date).toBe("2005-06-07");
    expect(selection.releaseDateSource).toBe("musicbrainz_release");
  });
});
