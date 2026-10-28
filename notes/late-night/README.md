# The late-night work

The work from the night of 2026-10-22 is split into a stack of branches. Each one
builds on the one before it, so each PR targets the branch above it in this list.

| Branch | What it adds |
| --- | --- |
| `feat/release-selection` | The uncommitted MusicBrainz query and release selection work from the main checkout, unchanged. |
| `feat/sqlite-busy-timeout` | `PRAGMA busy_timeout = 5000` (vault task 001). |
| `feat/opus-audio` | Opus downloads, Content-Type by extension, file names with the YouTube id, the unused conversion script. |
| `feat/ingest-pool` | The adaptive worker pool, command timeouts and process groups, graceful stop and job recovery, atomic track saves, concurrent duplicates. |
| `feat/metadata-matching` | Recording and release scoring, studio and single preference, album helpers. |
| `feat/imports-and-playlists` | Import preview and modes, playlists, queue actions, track numbers. Needs both migrations. |
| `feat/react-client` | The React client and these notes. |

The stack starts from `feat/ingest-file-logging` at 77c48b8. `late-night` is the
original integration branch with the same code as the top of the stack.

`contract.md` has the HTTP API and the schema additions.

## Before running it against the real database

1. Back up `tracks.sqlite`.
2. Apply `drizzle/manual/0001_imports_and_playlists.sql` once. It creates `playlists`,
   `playlist_tracks` and `imports`, and adds `import_id`, `position` and `track_id` to `jobs`.
   Without it, the worker and the import and playlist routes fail.
3. Apply `drizzle/manual/0002_track_numbers.sql` once. It adds the nullable `disc_number` and
   `track_number` columns to `tracks_table`. Album order falls back to insertion order until
   they are filled. It fails if run twice, so check the columns first.
4. Run `bun install`. The client needs `react`, `react-dom` and `bun-plugin-tailwind`.
5. Restart the server and the worker. Neither picks up the new code without a restart.
6. On its first start, the new worker requeues every job left `running` in the real DB and fails
   any whose `claim_count` is already 3 or more. Check
   `select id, url, claim_count from jobs where status = 'running'` first if that matters.
   Stop the worker with one Ctrl-C: it stops claiming, waits up to 20s for jobs in flight,
   then requeues the rest. A second Ctrl-C exits at once.

Existing tracks keep their `.m4a` files. New downloads are `.opus`. The stream route picks
the content type from the file extension, so both kinds play.
`src/scripts/convert-library-to-opus.ts` exists but was not run, and Akash decided against
converting the library.

## What changed

| Area | Change | Main files |
| --- | --- | --- |
| Codec | yt-dlp keeps YouTube's Opus stream and remuxes it to Ogg Opus, with no transcode. Thumbnails are not embedded, because that needs the `mutagen` Python module. | `src/utils/fetchAudio.ts`, `src/utils/audioContentType.ts` |
| File names | `audio/<title>_<youtubeId>.opus`. Two videos with the same title can no longer overwrite each other's file. | `src/utils/audioPath.ts` |
| Ingest concurrency | The worker keeps up to N jobs in flight, and N follows MemAvailable, cgroup headroom, PSI and load. The default cap is 8, with a per-job estimate of 400 MB. The worker runs at nice 10 with idle I/O. Settings: `INGEST_CONCURRENCY`, `INGEST_MAX_CONCURRENCY`, `INGEST_JOB_MEMORY_MB`. | `src/workers/ingestTrack/{resources,concurrency,pool,priority,claimForPool}.ts` |
| SQLite locks | `PRAGMA busy_timeout = 5000` on the shared connection (vault task 001). | `src/server/db/index.ts` |
| Concurrent duplicates | A unique clash at insert time is treated as "already in library", and the job is linked to the existing track. A second job for the same YouTube id waits for the first. | `src/services/ingestTrack.ts`, `src/services/youtubeIdClaims.ts` |
| Matching | Recordings are scored on title, artist and duration. Releases are scored on official status, secondary types, date and the album hint. Release choice depends on the import mode: `single`, `album` or `playlist`. In `playlist` mode the single release is preferred. | `src/utils/metadata-utils.ts` |
| Album imports | `POST /import/preview` classifies the URL, lists one entry per edition, and asks only when two editions are close. Album imports match every video to a track on the chosen release, so all songs land on one release group. | `src/services/importAnalysis.ts`, `src/server/index.ts` |
| Playlists | CRUD, reorder, and queueing. A YouTube playlist import can fill a Sonora playlist in YouTube order. | `src/server/index.ts` |
| Queue | `POST /queue/tracks` handles play all, shuffle and play next. `?shuffle=1` works on the album and playlist queue routes. Playlists now queue at the top, as albums do. | `src/server/db/transactions/insertTracksAtQueueTop.ts` |
| Client | The React client from sonora-main, redesigned after the Apple Music references in `apple-music-refs/`. | `src/app/` |

## Measured

- A 54-song playlist imported in 2.1 minutes, or 22 songs a minute. Earlier large imports on
  the 2-at-a-time worker ran at 4.5 to 6.3 songs a minute.
- One download peaks at about 310 to 370 MB RSS. Most of that is yt-dlp's `deno` helper.
- GUTS (spilled), 17 songs, and GUTS, 12 songs, both imported from YouTube Music album links.
  Every song landed on one release group, with no fallbacks.

## Open decisions

- `PRAGMA foreign_keys` is off on the app connection, so no `ON DELETE CASCADE` or `SET NULL`
  in the schema ever runs. Playlist delete cleans up by hand.
- A unique clash on insert still logs `database_transaction_failed` at error level, even
  though the job then completes as a duplicate.
- An album import leaves a song that is already stored on its existing release group (decided).
- Videos that need YouTube Music Premium fail at the metadata step unless yt-dlp is given
  cookies.
- Switching the disk scheduler to `bfq`, or using a systemd unit with `MemoryHigh` and
  `CPUWeight`, would make the worker's low priority stronger. That needs OS changes, which
  were not made.
