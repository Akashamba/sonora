import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_FILE_NAME = join(
  await mkdtemp(join(tmpdir(), "sonora-metadata-db-")),
  "test.sqlite",
);
const {
  albumArtistFromEntries,
  albumNeedsConfirmation,
  albumSearchTermsFromPlaylist,
  collapseAlbumCandidates,
  detectPlaylistKind,
  matchAlbumRecording,
  scoreAlbumCandidates,
  scoreRecordingCandidates,
  selectReleaseForMode,
} = await import("../src/utils/metadata-utils");
const wrongExample = await Bun.file(
  new URL("./fixtures/wrong-gone-gone-gone.json", import.meta.url),
).json();

describe("metadata candidate selection", () => {
  test("recognizes YouTube Music album playlist ids and ordinary playlists", () => {
    expect(detectPlaylistKind("OLAK5uy_test")).toBe("album");
    expect(detectPlaylistKind("PLtest")).toBe("playlist");
  });
  test("rejects a same-title recording by an unrelated artist from a real ingest response", () => {
    expect(
      scoreRecordingCandidates(wrongExample.recordings, wrongExample.youtube),
    ).toEqual([]);
  });

  test("uses YouTube duration to prefer the closer recording among valid credits", () => {
    const candidates = [
      {
        id: "long",
        title: "Song",
        length: 300000,
        score: 100,
        "artist-credit": [{ name: "Artist" }],
      },
      {
        id: "near",
        title: "Song",
        length: 202000,
        score: 90,
        "artist-credit": [{ name: "Artist" }],
      },
    ];
    expect(
      scoreRecordingCandidates(candidates, {
        track: "Song",
        artists: ["Artist"],
        album: null,
        durationMs: 201000,
      })[0]?.id,
    ).toBe("near");
  });

  test("chooses a matching album hint, and a single for non-album playlists", () => {
    const standard = {
      id: "standard",
      date: "2001",
      title: "Album",
      status: "Official",
      "release-group": { id: "rg1", title: "Album", "primary-type": "Album" },
    };
    const single = {
      id: "single",
      date: "2002",
      title: "Song",
      status: "Official",
      "release-group": { id: "rg2", title: "Song", "primary-type": "Single" },
    };
    const recording = { releases: [standard, single] };
    expect(selectReleaseForMode(recording, "single", "Album").id).toBe(
      "standard",
    );
    expect(selectReleaseForMode(recording, "playlist").id).toBe("single");
  });

  // The YouTube entry count decides between editions: a 14-entry playlist is the deluxe,
  // a 10-entry playlist is the standard album.
  const editions = [
    {
      id: "standard",
      title: "Example Album",
      status: "Official",
      "artist-credit": [{ name: "Artist" }],
      media: [{ "track-count": 10 }],
    },
    {
      id: "deluxe",
      title: "Example Album (Deluxe Edition)",
      status: "Official",
      "artist-credit": [{ name: "Artist" }],
      media: [{ "track-count": 14 }],
    },
  ];
  test("picks the deluxe edition when the YouTube playlist has the deluxe track count", () => {
    const candidates = scoreAlbumCandidates(
      editions,
      "Example Album",
      "Artist - Topic",
      14,
    );
    expect(candidates[0]?.releaseId).toBe("deluxe");
    expect(candidates[0]?.score).toBeGreaterThan(candidates[1]!.score);
  });

  test("picks the standard edition when the YouTube playlist has the standard track count", () => {
    const candidates = scoreAlbumCandidates(
      editions,
      "Example Album",
      "Artist - Topic",
      10,
    );
    expect(candidates[0]?.releaseId).toBe("standard");
    expect(candidates[0]?.score).toBeGreaterThan(candidates[1]!.score);
  });

  test("matches feature and remaster title variants to album tracks", () => {
    const release = {
      media: [
        {
          tracks: [
            {
              position: 1,
              title: "Song",
              recording: { id: "song", title: "Song" },
            },
            {
              position: 2,
              title: "Bonus Track",
              recording: { id: "bonus", title: "Bonus Track" },
            },
          ],
        },
      ],
    };
    expect(
      matchAlbumRecording(release, "Song (feat. Guest)", null, 0)?.id,
    ).toBe("song");
    expect(matchAlbumRecording(release, "Song - Remastered", null, 0)?.id).toBe(
      "song",
    );
    expect(matchAlbumRecording(release, "Bonus Track", null, 0)?.id).toBe(
      "bonus",
    );
  });
});

function albumRelease(
  id: string,
  groupId: string,
  tracks: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    title: "Album",
    status: "Official",
    date: "1994-08-30",
    "artist-credit": [{ name: "Artist" }],
    "release-group": { id: groupId },
    media: [{ "track-count": tracks }],
    ...overrides,
  };
}

describe("album edition choice", () => {
  test("collapses pressings of one edition into the best pressing, one entry per track count", () => {
    const releases = [
      albumRelease("plain", "rg-a", 11, { date: null }),
      albumRelease("bootleg", "rg-a", 11, { status: "Bootleg", date: "1993" }),
      albumRelease("first", "rg-a", 11),
      albumRelease("covered", "rg-a", 11, {
        "cover-art-archive": { front: true },
      }),
      albumRelease("extra", "rg-a", 12),
      albumRelease("deluxe", "rg-b", 14),
    ];
    const collapsed = collapseAlbumCandidates(
      scoreAlbumCandidates(releases, "Album", "Artist", 11),
    );
    expect(collapsed.map((c) => c.releaseId)).toEqual([
      "covered",
      "extra",
      "deluxe",
    ]);
    expect(collapsed[0]?.hasCover).toBe(true);
  });

  test("keeps at most the requested number of editions", () => {
    const releases = [1, 2, 3, 4, 5, 6].map((n) =>
      albumRelease(`rg${n}`, `rg-${n}`, 10 + n),
    );
    expect(
      collapseAlbumCandidates(
        scoreAlbumCandidates(releases, "Album", "Artist", 11),
      ).length,
    ).toBe(5);
    expect(
      collapseAlbumCandidates(
        scoreAlbumCandidates(releases, "Album", "Artist", 11),
        2,
      ).length,
    ).toBe(2);
  });

  test("drops a single whose title matches the album when the playlist has many more entries", () => {
    const releases = [
      albumRelease("single", "rg-single", 1, { title: "Album" }),
      albumRelease("ep", "rg-ep", 6, { title: "Album EP" }),
    ];
    const candidates = scoreAlbumCandidates(releases, "Album", "Artist", 7);
    expect(candidates.map((c) => c.releaseId)).toEqual(["ep"]);
  });

  test("does not ask when the only close rival is another pressing of the same edition", () => {
    const releases = [
      albumRelease("first", "rg-a", 11),
      albumRelease("extra", "rg-a", 12),
    ];
    expect(
      albumNeedsConfirmation(
        scoreAlbumCandidates(releases, "Album", "Artist", 11),
        11,
      ),
    ).toBe(false);
  });

  test("does not ask when a deluxe edition fits the playlist clearly worse", () => {
    const releases = [
      albumRelease("standard", "rg-a", 11),
      albumRelease("deluxe", "rg-b", 14),
    ];
    expect(
      albumNeedsConfirmation(
        scoreAlbumCandidates(releases, "Album", "Artist", 11),
        11,
      ),
    ).toBe(false);
  });

  test("does not ask when the standard album has fewer tracks than a 14-entry deluxe playlist", () => {
    const releases = [
      albumRelease("deluxe", "rg-b", 14),
      albumRelease("standard", "rg-a", 10),
    ];
    expect(
      albumNeedsConfirmation(
        scoreAlbumCandidates(releases, "Album", "Artist", 14),
        14,
      ),
    ).toBe(false);
  });

  test("asks when another edition scores about as well as the best one", () => {
    const releases = [
      albumRelease("standard", "rg-a", 11),
      albumRelease("other", "rg-b", 11),
    ];
    expect(
      albumNeedsConfirmation(
        scoreAlbumCandidates(releases, "Album", "Artist", 11),
        11,
      ),
    ).toBe(true);
  });

  test("asks when the best fit is weak or there is no candidate", () => {
    const weak = [
      albumRelease("weak", "rg-a", 11, { title: "Something Else" }),
    ];
    expect(
      albumNeedsConfirmation(
        scoreAlbumCandidates(weak, "Album", "Artist", 11),
        11,
      ),
    ).toBe(true);
    expect(albumNeedsConfirmation([], 11)).toBe(true);
  });
});

describe("album artist from playlist entries", () => {
  test("takes the most common entry channel, ignoring Topic suffix", () => {
    expect(
      albumArtistFromEntries([
        { uploader: "Olivia Rodrigo" },
        { uploader: "Olivia Rodrigo" },
        { channel: "Olivia Rodrigo - Topic" },
        { uploader: "Someone Else" },
      ]),
    ).toBe("Olivia Rodrigo");
  });
  test("returns null when no entry names a channel", () => {
    expect(albumArtistFromEntries([{}, { uploader: " " }])).toBeNull();
    expect(albumArtistFromEntries([])).toBeNull();
  });
});

describe("album search terms from playlist", () => {
  test("uses Topic uploader as artist and keeps title as album", () => {
    expect(
      albumSearchTermsFromPlaylist("Definitely Maybe", "Oasis - Topic"),
    ).toEqual({ album: "Definitely Maybe", artist: "Oasis" });
  });
  test("splits Artist - Album from title when uploader is not Topic and strips noise", () => {
    expect(
      albumSearchTermsFromPlaylist(
        "Oasis - Definitely Maybe (Full Album)",
        "randomuser",
      ),
    ).toEqual({ album: "Definitely Maybe", artist: "Oasis" });
    expect(
      albumSearchTermsFromPlaylist(
        "Definitely Maybe (Deluxe Edition Remastered)",
        "randomuser",
      ),
    ).toEqual({ album: "Definitely Maybe", artist: null });
  });
  test("strips trailing year suffix", () => {
    expect(
      albumSearchTermsFromPlaylist("Oasis - Definitely Maybe - 1994", null),
    ).toEqual({ album: "Definitely Maybe", artist: "Oasis" });
  });
});
