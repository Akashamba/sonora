@/home/bside/vault/CLAUDE-vault.md

# Sonora
Sonora is a self hosted music streaming app that allows a user to paste a youtube song or playlist url and download tracks into the app. Tracks are stored locally and managed with a local sqlite db. the client is a react web app.

Sonora serves one user. There is no users table or login. Queue and history code is written to allow multiple users later, but nothing does that yet.

# Ingest
Ingest runs in a separate worker process (`src/workers/ingestTrack`). Ingest flow:

1. The server creates a `jobs` row per URL, status `queued`.
2. On worker start, stale `running` jobs go back to `queued`. A job claimed 3 times without finishing is marked `failed`.
3. A pool claims the oldest queued jobs, up to a target of 8 that adapts to memory and load.
4. Each job:
   - Skips if the YouTube ID or MusicBrainz recording is already stored.
   - Fetches YouTube metadata and a MusicBrainz match, then falls back to YouTube metadata if there is no match.
   - Downloads the audio with yt-dlp, 3 attempts.
   - Writes the track in one transaction. A unique-key conflict links to the existing track.
5. The job is marked `completed` or `failed`.

On SIGINT or SIGTERM, the worker stops claiming and requeues what is still running.

# Other notes
Audio is served with HTTP range requests, so seeking works without re-downloading the file.

Task tracking for this project is at `/home/bside/vault/projects/sonora/`.
Follow the imported vault rules above. In short: task files are yours to edit, `index.md` is not,
and new task files need an explicit request from Akash.
