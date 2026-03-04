# Personal Music Streaming Server — Project Overview

## What This Is

A self-hosted music streaming setup for personal use. The goal is to own and control a music library, stream it from a personal server to any device, and gradually build the library on demand rather than bulk downloading upfront. Long-term the same server will host a Jellyfin instance for movies and TV.

---

## Music Source

Music is sourced and managed locally. The server supports yt-dlp integration for audio downloads, with on-demand downloading triggered from within the app to gradually build the library over time. The Internet Archive Live Music Archive can also be a supported source for authorized recordings. Soulseek support is planned as a future addition via a TypeScript client library, for broader library coverage.

---

## App

Built in **Expo (React Native)** with a web export that doubles as a **PWA**. One codebase for both.

**Deployment phases:**

1. **PWA first** — Expo web export, add to home screen on iOS/Android. Gets the app working immediately with no Apple account needed.
2. **Xcode direct install** — Free Apple developer account, install native build via USB. 7-day certificate expiry requires re-signing periodically (30 seconds plugged into Mac). Native audio session means reliable background playback and Bluetooth/AirPlay media controls.
3. **$99/year if needed** — Only if the 7-day re-signing becomes too annoying. No App Store submission, no Apple review process at any point on the free path.

No Apple review is ever required. The $99 program is only needed for TestFlight or App Store distribution.

Bluetooth and AirPlay work transparently at the OS level regardless of where the audio comes from. Lock screen controls work reliably on the native build via expo-av.

---

## Frontend Stack

| Layer     | Choice                                                  |
| --------- | ------------------------------------------------------- |
| Framework | Expo (React Native + web)                               |
| Language  | TypeScript                                              |
| Routing   | Expo Router (file-based, similar to Next.js App Router) |
| Audio     | expo-av                                                 |
| State     | Zustand                                                 |
| UI        | Tailwind (via NativeWind) + shadcn where applicable     |

---

## Backend Stack

| Layer                 | Choice                                                        |
| --------------------- | ------------------------------------------------------------- |
| Runtime               | Bun                                                           |
| API (data/browsing)   | tRPC — shared types across frontend and backend               |
| API (audio streaming) | Next.js Route Handler or Hono with HTTP range request support |
| ORM                   | Drizzle                                                       |
| Database              | Postgres                                                      |
| Metadata scanning     | music-metadata npm package                                    |
| Downloader            | yt-dlp (shell out from tRPC mutation)                         |

Range requests on the streaming endpoint are what enable seeking within tracks. tRPC handles everything else: library browsing, search, download triggers, auth.

---

## On-Demand Download Flow

1. Search local library
2. If no results, query YouTube Data API (free tier)
3. User selects a result
4. Server shells out to yt-dlp, downloads the track
5. Library rescans
6. Track becomes available for streaming

This is a well-established pattern used by self-hosted media tools. It keeps the library lean and avoids bulk downloading.

---

## Auth

Google SSO via **Better Auth**. After OAuth callback, the server checks the authenticated email against an allowlist env variable and rejects anyone else. Simple, no passwords to manage, works seamlessly on all devices since Google session is usually already active.

```
ALLOWED_EMAIL=you@gmail.com
```

No credentials are ever committed to the repo.

---

## Server & Infrastructure

**MVP:** Local machine exposed via **Cloudflare Tunnel** (free). No port forwarding, no dynamic DNS, automatic HTTPS. Good for validating the app before spending money.

**Production:** **Hetzner CAX11** VPS (~€4-6/month, ARM). Storage via a Hetzner Volume (€0.05/GB/month), scalable independently of the VPS. Only ports 80/443 exposed. Postgres bound to localhost only.

HTTPS via Cloudflare Tunnel (free) or Caddy on the VPS (automatic cert management).

---

## Open Source Considerations

The repo is application code only. Running an instance requires secrets that are never committed:

- Database credentials
- Auth secrets / JWT signing keys
- `ALLOWED_EMAIL` allowlist
- Server URL/domain

A `.env.example` with placeholder values documents the required variables. The codebase being public does not expose any user data.

---
