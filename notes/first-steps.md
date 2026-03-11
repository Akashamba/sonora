# First Steps

Architecture-wise you have three pieces.

- A Bun/tRPC server that handles library browsing, search, and triggers downloads, plus a Hono or Next.js route handler sitting alongside it that streams audio bytes with range request support.
- A Postgres database via Drizzle storing track metadata that gets populated by a `music-metadata` scanner.
- An Expo app that talks to tRPC for everything data-related and hits the streaming endpoint directly for audio playback.

For the MVP, Cloudflare Tunnel exposes all of this from your local machine so your phone can reach it over the internet.

## To get started

1. First add a handful of tracks to a local folder so you have something to work with.
2. Then write the scanner script that reads that folder, extracts metadata, and populates Postgres.
3. Then stand up a basic bun server with a couple of routes to browse what's in the DB.
4. set up client and trpc on server and client
5. move current backend to trpc
6. Then add the streaming endpoint and verify you can play a track in a browser.
7. Docker
8. Then build the Expo app — a simple list of tracks and a basic player with play/pause and seeking. Get it working as a PWA first, then connect via Xcode for the native install.

The streaming endpoint and the scanner are the two things worth getting right early; everything else is straightforward from there.

# Current Steps: Then write the scanner script that reads that folder, extracts metadata, and populates Postgres.

- [x] Set up typescript
- [x] set up sqlite
- [x] set up drizzle
- [x] create db object
- [ ] set up pipeline to download a song and add a record to db

# Pipeline of fetching m4a from youtube to writing to db for a given youtube URL

- extract and store youtube video ID and original url (primary dedup key to avoid redownloading a song again)
- fetch metadata first before downloading audio

```sh
yt-dlp --dump-json <url>
```

- parse metadata
  - regex clean up: comma separate artists, fetch track name, remove noise (official auido, etc)
  - useful yt-dlp metadata fields: title, track, artist, uploader, channel, duration, upload_date
- query MusicBrainz for canonical artist lists, ids, etc (add sources: discog and last.fm down the line)
- based on url + metadata, decide if I want to download (check uniqueness based on yt id and musicbrainz id)
- download audio

```sh
yt-dlp -f ba --extract-audio --audio-format m4a --embed-metadata --embed-thumbnail
```

- Store as: audio/youtube/{youtube_id}.m4a (scale to other sources down the line)
- Insert record of new song (and album, artist if applicable) into db

# DB Schema

- mock schema in chatgot conv, need to verfiy and add

## 1. Songs

## 2. Albums

## 3. Artists

## 4. Playlists
