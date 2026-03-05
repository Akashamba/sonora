# First Steps

Architecture-wise you have three pieces.

- A Bun/tRPC server that handles library browsing, search, and triggers downloads, plus a Hono or Next.js route handler sitting alongside it that streams audio bytes with range request support.
- A Postgres database via Drizzle storing track metadata that gets populated by a `music-metadata` scanner.
- An Expo app that talks to tRPC for everything data-related and hits the streaming endpoint directly for audio playback.

For the MVP, Cloudflare Tunnel exposes all of this from your local machine so your phone can reach it over the internet.

## To get started

1. First add a handful of tracks to a local folder so you have something to work with.
2. Then write the scanner script that reads that folder, extracts metadata, and populates Postgres.
3. Then stand up the tRPC server with a couple of routes to browse what's in the DB.
4. Then add the streaming endpoint and verify you can play a track in a browser.
5. Then build the Expo app — a simple list of tracks and a basic player with play/pause and seeking. Get it working as a PWA first, then connect via Xcode for the native install.

The streaming endpoint and the scanner are the two things worth getting right early; everything else is straightforward from there.
