# Sonora: Self-hosted music streaming app with a media ingestion pipeline
![[assets/sonora.jpg]]

Sonora is a self-hosted music server built on Bun. Paste in a link and a background ingestion worker fetches audio, reconciles metadata against multiple sources including MusicBrainz, and slots the track into your library, all without blocking the main server. Streaming supports range requests, so scrubbing through a track is instant rather than a full re-download. 

It's a solo project built to scratch a personal itch, currently running on hardware you probably wouldn't guess.

```markdown
[ link ] → ingestTrack (background worker)
              ├─ fetch audio + metadata
              ├─ match against MusicBrainz
              └─ write track/album to DB

client ⇄ Bun server ⇄ SQLite
         (range-request streaming, scrub-friendly)
```

Full write ups on the design decisions coming soon on my webiste: [akashamba.me](https://akashamba.me)

**Tech**: Bun, SQLite, Tailscale

**Quick Start Guide**
coming soon...
