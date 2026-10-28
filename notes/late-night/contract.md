# Late-night branch: shared contract

Work happens on four branches that merge into `late-night`. This file fixes the parts that
cross branches: the proposed schema additions and the HTTP API for imports and playlists.
Change it only by agreement with the integrator (the orchestrating agent).

## Hard rule: database

Akash has not approved schema changes yet. Do not run `db:push`, `db:migrate`, or any SQL
against `tracks.sqlite` in `/home/bside/projects/sonora` (the real DB). Schema additions go in
`src/server/db/schema.ts` plus a hand-written SQL file in `drizzle/manual/`, and are applied
only to throwaway copies (a temp file in tests, or `tracks.sqlite` inside a
`sonora-late-night*` worktree, which is a copy).

## Proposed schema additions

```
playlists
  id            text pk (uuidv7)
  name          text not null
  description   text
  source_url    text            -- the YouTube playlist URL when imported, else null
  created_at    int timestamp_ms not null
  updated_at    int timestamp_ms not null

playlist_tracks
  id            text pk (uuidv7)            -- "entryId" in the API
  playlist_id   text not null -> playlists.id on delete cascade
  track_id      text not null -> tracks_table.id on delete cascade
  position      real not null               -- fractional, like queue_table
  created_at    int timestamp_ms not null   -- "addedAt" in the API
  updated_at    int timestamp_ms not null
  unique (playlist_id, position)

imports
  id                            text pk (uuidv7)
  source_url                    text not null
  mode                          text not null   -- single | album | playlist
  title                         text            -- YouTube playlist title
  musicbrainz_release_id        text            -- chosen release, album mode only
  musicbrainz_release_group_id  text
  playlist_id                   text -> playlists.id on delete set null
  created_at, updated_at

jobs (new columns)
  import_id     text -> imports.id on delete set null
  position      int            -- 0-based index in the YouTube playlist
  track_id      text -> tracks_table.id on delete set null   -- the stored or matched track
```

## Track numbers (additive)

`tracks_table` gets two nullable columns, `disc_number INTEGER` and `track_number INTEGER`
(`drizzle/manual/0002_track_numbers.sql`). They are the medium position and the track
position on the MusicBrainz release. They are filled when the chosen release has a track
listing (album-mode matches, and any release object fetched with `inc=recordings+media`).
Recording search results do not carry track listings, so those tracks stay null until
`src/scripts/backfill-track-numbers.ts --apply` is run.

- `GET /release-groups/:id/tracks`: each track in `tracks` also has `track_number` and
  `disc_number` (number or null). Order is disc, track, insertion order, nulls last.
- `POST /release-groups/:id/queue`: queues tracks in the same order.
- Playlist and queue responses are unchanged.

## Track shape

Every endpoint that returns tracks uses the existing `TrackResponse`
(`src/types/api/Track.ts`): `{ id, title, length, artists[], release_group, liked, position }`.

## Import API

### `POST /import/preview`  body `{ url }`

Inspects the URL without creating jobs. A single-video URL returns quickly with `mode: "single"`.
Only YouTube hosts are accepted (`youtube.com`, `www.`, `m.`, `music.youtube.com`, `youtu.be`).
Any other host, a malformed playlist id (`list=`), or an unparseable video id is `400 { message }`
and nothing is fetched. A playlist URL is sent to yt-dlp rebuilt from its list id.

```jsonc
{
  "data": {
    "url": "https://...",
    "kind": "single" | "album" | "playlist",    // what the URL looks like
    "title": "Album - Some Album" | null,       // YouTube playlist title
    "uploader": "Artist - Topic" | null,
    "entryCount": 14,
    "entries": [
      { "position": 0, "youtubeId": "abc123def45", "title": "Song", "durationMs": 201000, "inLibrary": false }
    ],
    "albumCandidates": [
      {
        "releaseId": "mbid", "releaseGroupId": "mbid",
        "title": "Some Album", "artist": "Artist",
        "date": "2020-05-01" | null, "country": "US" | null,
        "trackCount": 14, "disambiguation": "deluxe edition" | null,
        "coverArtUrl": "https://..." | null,
        "score": 0.93                              // 0..1, higher is a better fit
      }
    ],
    "recommendation": { "mode": "album", "releaseId": "mbid" } | { "mode": "playlist" } | { "mode": "single" },
    "needsConfirmation": true                    // false when the recommendation is clear
  }
}
```

### `POST /import`  body

```jsonc
{
  "url": "https://...",
  "mode": "auto" | "single" | "album" | "playlist",   // optional, default "auto"
  "releaseId": "mbid",                                // album mode: the release to match against
  "playlist": { "create": true, "name": "Running" }   // optional: also fill a Sonora playlist
}
```

`{ url }` alone keeps working: the server runs the preview analysis and takes its recommendation.
Response `200`: `{ "data": { "importId", "jobCount", "playlistId": string | null }, "message" }`.
Errors keep the current `{ message }` shapes and status codes, plus `400 { message }` for a URL that is
not a YouTube URL (see above). The same URL check runs on `/import`, so a rejected URL creates no jobs.

### `GET /imports?limit=20`

`limit` defaults to 20, is clamped to 1..100, and a non-numeric value counts as the default.

`{ "data": [ { "id", "mode", "title", "sourceUrl", "playlistId", "createdAt", "counts": { "queued", "running", "completed", "failed" } } ] }`, newest first.

### `GET /imports/:id`

The same object plus `"jobs": [ { "id", "position", "status", "error", "trackId" } ]` ordered by position.

## Playlist API

All mutating routes are wrapped in `blockInDemo`.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/playlists` | | `{ count, data: Playlist[] }` |
| POST | `/playlists` | `{ name, description? }` | `{ data: Playlist }` (201) |
| GET | `/playlists/:id` | | `{ data: Playlist & { tracks: PlaylistEntry[] } }` |
| PATCH | `/playlists/:id` | `{ name?, description? }` | `{ data: Playlist }` |
| DELETE | `/playlists/:id` | | `204` |
| POST | `/playlists/:id/tracks` | `{ trackIds: string[] }` | `{ data: PlaylistEntry[] }` appended at the end |
| DELETE | `/playlists/:id/tracks/:entryId` | | `204` |
| PATCH | `/playlists/:id/tracks/:entryId` | `{ afterEntryId: string \| null }` (null = move to top) | `{ data: PlaylistEntry }` |
| POST | `/playlists/:id/queue?shuffle=1` | | `{ data: { track_id } }`, same as `/release-groups/:id/queue` (tracks go to the top of the queue) |

Status codes for the playlist routes (all errors are `{ message }`):

- Invalid or empty JSON body on any body route: `400 { message: "invalid or empty JSON body" }`.
- `POST /playlists` and `PATCH /playlists/:id`: a name that is missing or blank is `400 { message: "name is required" }`.
- Unknown playlist on any `/playlists/:id/...` route: `404 { message: "playlist not found" }`.
- `POST /playlists/:id/tracks`: unknown track ids are `400 { message, unknownIds }` and nothing is inserted.
  Duplicates in `trackIds` are kept.
- `DELETE` and `PATCH` of an entry: the entry must belong to that playlist, otherwise `404 { message: "entry not found" }`.
- `PATCH` of an entry: `afterEntryId` must be present (`400 "afterEntryId is required"`); `null` moves it to the top.
- `POST /playlists/:id/queue`: an empty playlist is `400 "playlist has no tracks"`.

Entries whose track no longer exists (deleted without its cascade) are hidden everywhere: `trackCount`,
`durationMs`, `coverArtUrls`, `tracks`, the queue route and reorder. Their rows still count for positions.

Append positions go after the highest of the playlist's last entry and the job slots (`jobs.position`)
of any import linked to the playlist, so a user append never takes a slot a pending job still needs.
Reorder keeps the same rule: when the midpoint hits a neighbour or a gap under 1e-9, the playlist is
renumbered inside its segments between pending job slots (integers 0..n-1 when no import is pending).

```ts
type Playlist = {
  id: string; name: string; description: string | null; sourceUrl: string | null;
  trackCount: number; durationMs: number;
  coverArtUrls: string[];   // up to 4 distinct small covers, for a mosaic
  createdAt: number; updatedAt: number;
};
type PlaylistEntry = { entryId: string; position: number; addedAt: number; track: TrackResponse };
```

## Queue API

The play queue is `queue_table`: lowest `position` plays next. Queue writes below insert at the
top, so the first track they return plays next. All are wrapped in `blockInDemo`.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/queue/tracks` | `{ trackIds: string[], shuffle?: boolean }` | `{ data: { track_id } }` |
| POST | `/release-groups/:id/queue?shuffle=1` | | `{ data: { track_id } }` |
| POST | `/playlists/:id/queue?shuffle=1` | | `{ data: { track_id } }` |
| POST | `/queue/play-from` | `{ position: number }` | `{ data: { track_id } }` |

- `GET /queue` (Up Next): one item per queue row, in queue order, each with its own `position`.
  A track queued twice is listed twice.
- `/queue/play-from` (Up Next tap-to-play): in one transaction deletes every queue row with a lower
  `position`, then pops the row at `position` through the same refill-then-pop as `/tracks/next`.
  It is not a shuffle or a re-insert: rows below the target stay where they are. `position` must be a
  finite number (`400 { message }` otherwise). No row at that position, or a row whose track is gone,
  is `404 { message: "queue row not found" }` and writes nothing.
- `/queue/tracks`: 1 to 1000 non-empty ids, inserted at the top in the given order (or shuffled).
  "Play next" is a single id. Unknown ids give `400 { message, unknownIds: string[] }` and insert nothing.
  Duplicate ids are kept.
- `?shuffle=1` (or `true`) on the album and playlist routes gives a random order of the same tracks.
- Album order is disc, then track, then insertion order (SQLite rowid). Tracks with no
  numbers yet come last. See "Track numbers" below.
- Playlist queue used to append at the bottom of the queue; it now goes to the top, like the album route.

## Audio

New downloads are Ogg Opus files named `audio/<name>.opus`. Existing rows still point at `.m4a`
files, so the stream route picks `Content-Type` from the file extension
(`.opus`/`.ogg` -> `audio/ogg; codecs=opus`, `.m4a` -> `audio/mp4`, `.webm` -> `audio/webm`).
