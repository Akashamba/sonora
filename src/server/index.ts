import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import {
  artists,
  history,
  play_counts,
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
          .select({ trackId: queue.track_id, position: queue.id })
          .from(queue)
          .all();

        const data = fetchTracksWithMetadata({
          trackIds: queueTracks.map((t) => t.trackId || ""),
        });

        return Response.json({
          count: data.length,
          data: data.map((t) => ({
            ...t,
            position: queueTracks.find((q) => q.trackId === t.id)?.position,
          })),
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

      // Set last played song as completed and update play counts
      db.transaction((tx) => {
        // get last played
        const last_played = tx
          .select({
            id: history.id,
            track_id: history.track_id,
            completed: history.completed,
            count: play_counts.count,
          })
          .from(history)
          .leftJoin(play_counts, eq(play_counts.track_id, history.track_id))
          .orderBy(desc(history.id))
          .limit(1)
          .get();

        if (last_played?.completed === 0) {
          // update history with completed 1
          tx.update(history)
            .set({ completed: 1 })
            .where(eq(history.id, last_played?.id!))
            .run();
          // upsert song to play_counts with count 1 (default) or increment by 1
          tx.insert(play_counts)
            .values({ track_id: last_played?.track_id })
            .onConflictDoUpdate({
              target: play_counts.track_id,
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

      return new Response(audioFile, {
        headers: {
          "Content-Type": "audio/mp4",
          "Content-Length": String(audioFile.size),
        },
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

      try {
        // urls.forEach((url) => ingestTrack(url));
        for (const url of urls) {
          ingestTrack(url);
          await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (err) {
        return Response.json(
          {
            message: `error while ingesting tracks: ${(err as Error).message}`,
          },
          {
            status: 500,
            headers: {
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      return Response.json(
        {
          message: "ingested tracks",
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
