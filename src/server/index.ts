import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import {
  artists,
  history,
  jobs,
  play_stats,
  queue,
  release_groups,
  track_artists,
  tracks,
} from "./db/schema";
import { file } from "bun";
import { getAllUrlsFromPlaylist } from "~/utils/metadata-utils";
import { ingestTrack } from "~/services/ingestTrack";
import { readFileSync } from "fs";
import { fetchTracksWithMetadata } from "./db/queries/fetchTrackWithMetadata";
import { fetchReleaseWithTracks } from "./db/queries/fetchReleaseWithTracks";
import { fetchNextTrackWithRefill } from "./db/transactions/fetchNextTrackWithRefill";

const server = Bun.serve({
  // `routes` requires Bun v1.2.3+
  routes: {
    "/": () => {
      const index = readFileSync("src/app/index.html", "utf8");
      return new Response(index, {
        headers: { "Content-Type": "text/html" },
      });
    },
    "/home": async () => {
      try {
        const topTracks = fetchTracksWithMetadata({ topTracks: true });
        const recentTracks = fetchTracksWithMetadata({ recentTracks: true });

        return Response.json({
          data: {
            topTracks: {
              count: topTracks.length,
              data: topTracks,
            },
            recentTracks: {
              count: recentTracks.length,
              data: recentTracks,
            },
          },
        });
      } catch (err) {
        console.log(
          `[${new Date().getUTCDate()}] error: ${(err as Error).message}`,
        );
        return new Response("INTERNAL SERVER ERROR", { status: 500 });
      }
    },
    "/artists": async () => {
      try {
        const allArtists = db.select().from(artists).all();
        return Response.json({ count: allArtists.length, data: allArtists });
      } catch (err) {
        console.log(
          `[${new Date().getUTCDate()}] error: ${(err as Error).message}`,
        );
        return new Response("INTERNAL SERVER ERROR", { status: 500 });
      }
    },
    "/release-groups": async () => {
      try {
        const allReleaseGroups = db.select().from(release_groups).all();
        return Response.json({
          count: allReleaseGroups.length,
          data: allReleaseGroups,
        });
      } catch (err) {
        console.log(
          `[${new Date().getUTCDate()}] error: ${(err as Error).message}`,
        );
        return new Response("INTERNAL SERVER ERROR", { status: 500 });
      }
    },
    "/release-groups/:id/tracks": async (req) => {
      try {
        const data = fetchReleaseWithTracks(req.params.id);
        return Response.json({ data: data });
      } catch {
        return new Response("INTERNAL SERVER ERROR", { status: 500 });
      }
    },
    "/artists/:id/tracks": async (req) => {
      try {
        const artistTrackIds = db
          .select({ trackId: track_artists.track_id })
          .from(artists)
          .where(eq(artists.id, req.params.id))
          .leftJoin(track_artists, eq(track_artists.artist_id, artists.id))
          .all();

        const data = fetchTracksWithMetadata({
          trackIds: artistTrackIds.map((t) => t.trackId || ""),
        });

        return Response.json({
          count: data.length,
          data: data,
        });
      } catch (err) {
        console.log(
          `[${new Date().getUTCDate()}] error: ${(err as Error).message}`,
        );
        return new Response("INTERNAL SERVER ERROR", { status: 500 });
      }
    },
    "/tracks/next": async () => {
      const nextTrack = fetchNextTrackWithRefill();

      if (!nextTrack || !nextTrack.track_id) {
        return Response.json(
          { error: "INTERNAL SERVER ERROR: Queue is empty" },
          {
            status: 504,
          },
        );
      }

      return Response.json({
        data: { track_id: nextTrack.track_id },
      });
    },
    "/tracks/previous": async () => {
      // this will only return the song that is currently playing.
      // TODO: make this actually traverse through history without affecting the actual history of played songs
      const prevTrack = db
        .select({ id: history.track_id })
        .from(history)
        .orderBy(desc(history.id))
        .limit(1)
        .get();

      if (!prevTrack || !prevTrack.id) {
        return Response.json(
          { error: "INTERNAL SERVER ERROR: Queue is empty" },
          {
            status: 504,
          },
        );
      }

      return Response.json({
        data: { track_id: prevTrack.id },
      });
    },
    "/release-groups/:id/queue": async (req) => {
      try {
        const firstTrack = db.transaction((tx) => {
          const albumTracks = tx
            .select({ id: tracks.id })
            .from(tracks)
            .where(eq(tracks.release_group_id, req.params.id))
            .all();
          const queueTop = tx
            .select({ position: queue.position })
            .from(queue)
            .orderBy(queue.position)
            .limit(1)
            .get();

          tx.insert(queue)
            .values(
              albumTracks.map((t, i) => ({
                track_id: t.id,
                position: queueTop?.position! - albumTracks.length + i,
              })),
            )
            .run();
          return albumTracks[0];
        });

        return Response.json({ data: { track_id: firstTrack?.id } });
      } catch {
        return new Response("INTERNAL SERVER ERROR", { status: 500 });
      }
    },
    "/tracks/search": (req) => {
      const url = new URL(req.url);

      const data = fetchTracksWithMetadata({
        query: url.searchParams.get("q") ?? "",
        limit: Number(url.searchParams.get("limit") ?? 20),
        offset: Number(url.searchParams.get("offset") ?? 0),
      });

      return Response.json({
        data: data,
        count: data.length,
        offset: Number(url.searchParams.get("offset") ?? 0),
      });
    },
    "/queue": async () => {
      try {
        const queueTracks = db
          .select({ trackId: queue.track_id })
          .from(queue)
          .all();

        const data = fetchTracksWithMetadata({
          trackIds: queueTracks.map((t) => t.trackId || ""),
          queueTracks: true,
        });

        return Response.json({
          count: data.length,
          data: data,
        });
      } catch (err) {
        console.log(
          `[${new Date().getUTCDate()}] error: ${(err as Error).message}`,
        );
        return new Response("INTERNAL SERVER ERROR", { status: 500 });
      }
    },
    "/tracks/:id/metadata": async (req) => {
      try {
        const [data] = fetchTracksWithMetadata({ trackId: req.params.id });

        return Response.json({
          data: data,
        });
      } catch (err) {
        console.log(
          `[${new Date().getUTCDate()}] error: ${(err as Error).message}`,
        );
        return new Response("INTERNAL SERVER ERROR", { status: 500 });
      }
    },
    "/tracks/:id/like": async (req) => {
      try {
        const trackId = req.params.id;

        // toggle like status
        const currentStatus = db
          .select({ liked: play_stats.liked })
          .from(play_stats)
          .where(eq(play_stats.track_id, trackId))
          .get();

        if (currentStatus) {
          db.update(play_stats)
            .set({ liked: currentStatus.liked ? 0 : 1 })
            .where(eq(play_stats.track_id, trackId))
            .run();
        } else {
          db.insert(play_stats).values({ track_id: trackId, liked: 1 }).run();
        }

        return Response.json({
          data: { liked: !currentStatus?.liked },
        });
      } catch (err) {
        console.log(
          `[${new Date().getUTCDate()}] error: ${(err as Error).message}`,
        );
        return new Response("INTERNAL SERVER ERROR", { status: 500 });
      }
    },
    "/tracks/:id/stream": async (req) => {
      // enable long-lived streaming connectionj
      server.timeout(req, 0);

      const [track] = await db
        .select({ id: tracks.id, filePath: tracks.file_path })
        .from(tracks)
        .where(eq(tracks.id, req.params.id));

      if (!track) {
        return new Response("Track not found", { status: 404 });
      }

      const audioFile = file(track.filePath);
      const exists = await audioFile.exists();

      if (!exists) return new Response("File not found", { status: 404 });

      const total = audioFile.size;
      const rangeHeader = req.headers.get("range");

      // Only record playback history on the initial, non-range (or start-at-zero) request.
      // A single play generates many range requests (Safari's bytes=0-1 probe, seeks, etc.),
      // so we'd otherwise insert many history rows per actual play.
      let start = 0;
      let end = total - 1;
      let isPartial = false;

      if (rangeHeader) {
        // Parse a single range: bytes=START-END | bytes=START- | bytes=-SUFFIX
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());

        if (!match) {
          return new Response("Invalid range", {
            status: 416,
            headers: { "Content-Range": `bytes */${total}` },
          });
        }

        const [, startStr, endStr] = match;

        if (startStr === "" && endStr === "") {
          return new Response("Invalid range", {
            status: 416,
            headers: { "Content-Range": `bytes */${total}` },
          });
        }

        if (startStr === "") {
          // suffix range: last N bytes
          const suffix = Number(endStr);
          start = Math.max(0, total - suffix);
          end = total - 1;
        } else {
          start = Number(startStr);
          end = endStr === "" ? total - 1 : Math.min(Number(endStr), total - 1);
        }

        // start beyond EOF, or inverted range
        if (start >= total || start > end) {
          return new Response("Range not satisfiable", {
            status: 416,
            headers: { "Content-Range": `bytes */${total}` },
          });
        }

        isPartial = true;
      }

      // Record history only on the initial request: no Range header, or a range
      // that begins at byte 0 (the first chunk of a fresh playback).
      const shouldRecordHistory = !rangeHeader || start === 0;

      if (shouldRecordHistory) {
        // Set last played song as completed and update play counts
        db.transaction((tx) => {
          // get last played
          const last_played = tx
            .select({
              id: history.id,
              track_id: history.track_id,
              completed: history.completed,
              count: play_stats.count,
            })
            .from(history)
            .leftJoin(play_stats, eq(play_stats.track_id, history.track_id))
            .orderBy(desc(history.id))
            .limit(1)
            .get();

          if (last_played?.completed === 0) {
            // update history with completed 1
            tx.update(history)
              .set({ completed: 1 })
              .where(eq(history.id, last_played?.id!))
              .run();
            // upsert song to play_stats with count 1 (default) or increment by 1
            tx.insert(play_stats)
              .values({ track_id: last_played?.track_id })
              .onConflictDoUpdate({
                target: play_stats.track_id,
                set: { count: last_played?.count! + 1 },
              })
              .run();
          }
        });

        // set now playing: add to history with completed=0 (default)
        db.insert(history)
          .values({
            track_id: track.id,
          })
          .run();
      }

      // Build the response body. .slice() returns a lazy view — no full read into memory.
      const body = isPartial ? audioFile.slice(start, end + 1) : audioFile;

      const headers: Record<string, string> = {
        "Content-Type": "audio/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
      };

      if (isPartial) {
        headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
      }

      return new Response(body, {
        status: isPartial ? 206 : 200,
        headers,
      });
    },
    "/import": async (req) => {
      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      // Safely parse JSON
      let body;
      try {
        body = await req.json();
      } catch {
        return Response.json(
          { message: "invalid or empty JSON body" },
          { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }

      const url = body?.url;

      if (!url) {
        return Response.json(
          {
            message: "no url sent",
          },
          {
            headers: {
              "Access-Control-Allow-Origin": "*",
            },
            status: 500,
          },
        );
      }

      const urls = await getAllUrlsFromPlaylist(url);

      urls.forEach((url) => db.insert(jobs).values({ url }).run());
      console.log("created jobs to ingest tracks");

      return Response.json(
        {
          message: "created jobs to ingest tracks",
        },
        {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    },
  },
  hostname: "0.0.0.0",
  // (optional) fallback for unmatched routes:
  // Required if Bun's version < 1.2.3
  fetch(req) {
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server running at ${server.url}`);
