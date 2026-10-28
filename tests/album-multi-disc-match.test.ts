import { describe, expect, test } from "bun:test";
import { matchAlbumRecording } from "~/utils/metadata-utils";
import { trackPositionOnRelease } from "~/utils/trackPosition";

// Disc 1 has 10 tracks, disc 2 has 12. Track positions restart on each disc, but the
// YouTube playlist position counts across discs.
function row(position: number, title: string, id: string) {
  return {
    position,
    title,
    length: 180000,
    recording: { id, title, length: 180000 },
  };
}
function release(disc1Titles: string[], disc2Titles: string[]) {
  return {
    id: "release-1",
    media: [
      {
        position: 1,
        tracks: disc1Titles.map((t, i) => row(i + 1, t, `d1-${i + 1}`)),
      },
      {
        position: 2,
        tracks: disc2Titles.map((t, i) => row(i + 1, t, `d2-${i + 1}`)),
      },
    ],
  };
}

const filler = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);

describe("matchAlbumRecording on multi-disc releases", () => {
  test("the position fallback uses the absolute index, not the per-disc position", () => {
    const rel = release(filler("Disc One", 10), filler("Disc Two", 12));

    // Playlist index 10 is the 11th track overall: disc 2, track 1.
    const match = matchAlbumRecording(rel, "Unknown title", null, 10);
    expect(match?.id).toBe("d2-1");
    expect(trackPositionOnRelease(rel, "d2-1")).toEqual({
      disc_number: 2,
      track_number: 1,
    });
  });

  test("a title on both discs resolves to the copy at the playlist position", () => {
    const rel = release(
      ["Intro", ...filler("Disc One", 9)],
      ["Intro", ...filler("Disc Two", 11)],
    );

    expect(matchAlbumRecording(rel, "Intro", null, 0)?.id).toBe("d1-1");
    expect(matchAlbumRecording(rel, "Intro", null, 10)?.id).toBe("d2-1");
    expect(trackPositionOnRelease(rel, "d2-1")).toEqual({
      disc_number: 2,
      track_number: 1,
    });
  });

  test("a single-disc release matches by position as before", () => {
    const rel = {
      id: "single-disc",
      media: [
        {
          position: 1,
          tracks: filler("Track", 8).map((t, i) => row(i + 1, t, `s-${i + 1}`)),
        },
      ],
    };

    expect(matchAlbumRecording(rel, "Unknown title", null, 2)?.id).toBe("s-3");
  });
});
