// Shared inputs for the import analysis tests: a YouTube Music album playlist, the
// MusicBrainz releases it matches, and a fake yt-dlp that prints the playlist JSON.

export const OLAK_ID = "OLAK5uy_ldvkda_TXNkemSOhB9iYIt5nUWjkTQwIA";
export const OLAK_URL = `https://music.youtube.com/playlist?list=${OLAK_ID}`;
export const OTHER_ID = "PLroadtripmix0000000000";
export const OTHER_URL = `https://www.youtube.com/playlist?list=${OTHER_ID}`;

// Two pressings of the same release group with identical scores and dates. Only the
// release id differs, so the tie-break decides which one is recommended.
export const PRESSING_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const PRESSING_B = "aaaaaaaa-0000-4000-8000-000000000002";
export const DELUXE = "aaaaaaaa-0000-4000-8000-000000000003";
export const UNLISTED = "aaaaaaaa-0000-4000-8000-000000000009";

function release(
  id: string,
  overrides: Record<string, unknown> & { groupId: string; tracks?: number },
) {
  const { groupId, tracks = 12, ...rest } = overrides;
  return {
    id,
    title: "GUTS",
    status: "Official",
    date: "2023-09-08",
    country: "US",
    media: [{ "track-count": tracks }],
    "artist-credit": [
      { name: "Olivia Rodrigo", artist: { name: "Olivia Rodrigo" } },
    ],
    "release-group": { id: groupId, "primary-type": "Album" },
    "cover-art-archive": { front: true },
    ...rest,
  };
}

export const releases = [
  release(PRESSING_B, { groupId: "rg-guts", country: "GB" }),
  release(PRESSING_A, { groupId: "rg-guts" }),
  release(DELUXE, {
    groupId: "rg-guts-deluxe",
    title: "GUTS (Deluxe Edition)",
    date: "2024-01-01",
    tracks: 17,
  }),
];

// Answers for release lookups by id (GET /ws/2/release/:id).
export const releaseById: Record<string, unknown> = {
  ...Object.fromEntries(releases.map((r) => [r.id, r])),
  [UNLISTED]: release(UNLISTED, {
    groupId: "rg-other",
    title: "GUTS (Unlisted)",
  }),
};

export function playlistJson(
  id: string,
  title: string,
  uploader: string | null,
  count: number,
) {
  return {
    id,
    title,
    uploader,
    entries: Array.from({ length: count }, (_, i) => ({
      id: `GUTSTRK${String(i).padStart(3, "0")}`,
      url: `https://music.youtube.com/watch?v=GUTSTRK${String(i).padStart(3, "0")}`,
      title: `Track ${i + 1}`,
      duration: 180 + i,
      uploader: "Olivia Rodrigo",
      channel: "Olivia Rodrigo",
    })),
  };
}

// Writes the MusicBrainz stub's answers to a JSON file, read by tests/fixtures/musicbrainz-stub.ts.
export function stubFileContents() {
  return JSON.stringify({ releases, byId: releaseById });
}

// A yt-dlp that prints the JSON for the playlist named in its arguments. Any other
// argument list fails, the way yt-dlp does for an unknown playlist.
export function fakeYtDlpScript(
  dir: string,
  playlists: Record<string, string>,
) {
  const cases = Object.entries(playlists)
    .map(
      ([id, file]) =>
        `  *${id}*) echo "$*" >> "${dir}/yt-dlp-calls.log"; cat "${file}" ;;`,
    )
    .join("\n");
  return `#!/bin/sh
case "$*" in
${cases}
  *) echo "$*" >> "${dir}/yt-dlp-calls.log"; echo "ERROR: unknown playlist" >&2; exit 1 ;;
esac`;
}

// A single video, as `yt-dlp --dump-json` prints it.
export const SINGLE_ID = "abcdefghijk";
export const SINGLE_URL = `https://www.youtube.com/watch?v=${SINGLE_ID}`;
export function singleVideoJson(id: string, title: string, duration: number) {
  return {
    id,
    title,
    duration,
    webpage_url: `https://www.youtube.com/watch?v=${id}`,
  };
}
