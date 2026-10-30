import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
  playlists,
  playlist_tracks,
  imports,
} from "./db/schema";
import { $, file } from "bun";
import { getAllUrlsFromPlaylist } from "~/utils/metadata-utils";
import {
  analyzeImportUrl,
  InvalidImportUrlError,
  normalizeImportUrl,
  releaseGroupIdForRelease,
  type ImportAnalysis,
} from "~/services/importAnalysis";
import index from "../app/index.html";
import { fetchTracksWithMetadata } from "./db/queries/fetchTrackWithMetadata";
import { fetchReleaseWithTracks } from "./db/queries/fetchReleaseWithTracks";
import { fetchNextTrackWithRefill } from "./db/transactions/fetchNextTrackWithRefill";
import { playFromQueuePosition } from "./db/transactions/playFromQueuePosition";
import {
  insertTracksAtQueueTop,
  UnknownTracksError,
} from "./db/transactions/insertTracksAtQueueTop";
import { blockInDemo } from "./middleware/demo-blocker";
import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  logIngestFailure,
  logIngestInfo,
  logIngestSuccess,
} from "~/utils/ingestLogger";
import { routeDbError } from "./routeDbError";
import { audioContentType } from "~/utils/audioContentType";
import { CommandError, killAllRunningCommands } from "~/utils/runCommand";
import { constants } from "node:os";
import { coverFilePath, coverRoute, ensureCover } from "~/utils/coverCache";

// Commands the server started run detached from the terminal, so a Ctrl-C or a stop
// signal would not reach them. Kill them, then exit with the status a signal death
// reports. The default action would end the process without running exit hooks.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    killAllRunningCommands();
    process.exit(128 + constants.signals[signal]);
  });
}

// ?shuffle=1 on the queue routes puts the tracks in random order
function isShuffle(req: Request) {
  const value = new URL(req.url).searchParams.get("shuffle");
  return value === "1" || value === "true";
}

type Executor = Pick<typeof db, "select">;

// Parses a JSON body that must be an object. Null means it is missing, not JSON, or not an object.
async function jsonObjectBody(
  req: Request,
): Promise<Record<string, any> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body
      : null;
  } catch {
    return null;
  }
}

function invalidJsonBody() {
  return Response.json(
    { message: "invalid or empty JSON body" },
    { status: 400 },
  );
}

// Entries whose track still exists. A track deleted without its cascade leaves its
// playlist_tracks row behind, and those rows are hidden from every read.
function liveEntries(executor: Executor, playlistId: string) {
  return executor
    .select({
      id: playlist_tracks.id,
      trackId: playlist_tracks.track_id,
      position: playlist_tracks.position,
      createdAt: playlist_tracks.created_at,
      length: tracks.length,
      releaseGroupId: release_groups.id,
      cover: release_groups.cover_art_url_thumbnail_small,
    })
    .from(playlist_tracks)
    .innerJoin(tracks, eq(tracks.id, playlist_tracks.track_id))
    .leftJoin(release_groups, eq(release_groups.id, tracks.release_group_id))
    .where(eq(playlist_tracks.playlist_id, playlistId))
    .orderBy(playlist_tracks.position)
    .all();
}

// Positions that pending import jobs will fill. The worker writes job.position as the
// playlist position, so an entry on one of these would make that job skip its song.
function pendingJobSlots(executor: Executor, playlistId: string): number[] {
  const slots = executor
    .select({ position: jobs.position })
    .from(jobs)
    .innerJoin(imports, eq(imports.id, jobs.import_id))
    .where(
      and(
        eq(imports.playlist_id, playlistId),
        inArray(jobs.status, ["queued", "running"]),
        isNotNull(jobs.position),
      ),
    )
    .all()
    .map((row) => row.position!);
  return [...new Set(slots)].sort((a, b) => a - b);
}

// The highest position this playlist holds or is still expecting: its last entry, or
// the last job slot of an import linked to it. Appends go after it.
function highestPlaylistPosition(executor: Executor, playlistId: string) {
  const entryMax = executor
    .select({ max: sql<number | null>`max(${playlist_tracks.position})` })
    .from(playlist_tracks)
    .where(eq(playlist_tracks.playlist_id, playlistId))
    .get()?.max;
  const jobMax = executor
    .select({ max: sql<number | null>`max(${jobs.position})` })
    .from(jobs)
    .innerJoin(imports, eq(imports.id, jobs.import_id))
    .where(eq(imports.playlist_id, playlistId))
    .get()?.max;
  const tops = [entryMax, jobMax].filter(
    (value): value is number => typeof value === "number",
  );
  return tops.length > 0 ? Math.max(...tops) : -1;
}

// How many pending slots sit at or below a position. Renumbering keeps each entry in
// its segment, so no entry moves across a pending slot.
function segmentOf(position: number, slots: number[]) {
  return slots.filter((slot) => slot <= position).length;
}

// New positions for entries given in final order, with segments[i] the segment of
// entry i (non-decreasing). Each entry lands strictly inside its segment, so none sits
// on a pending slot or changes side of one. Without slots this is 0..n-1.
function renumberPositions(segments: number[], slots: number[]): number[] {
  const out: number[] = new Array(segments.length);
  let start = 0;
  while (start < segments.length) {
    const segment = segments[start]!;
    let end = start;
    while (end < segments.length && segments[end] === segment) end++;
    const count = end - start;
    const low = segment > 0 ? slots[segment - 1] : undefined;
    const high = segment < slots.length ? slots[segment] : undefined;
    for (let k = 0; k < count; k++) {
      out[start + k] =
        low !== undefined && high !== undefined
          ? low + ((high - low) * (k + 1)) / (count + 1)
          : high !== undefined
            ? high - count + k
            : low !== undefined
              ? low + 1 + k
              : k;
    }
    start = end;
  }
  return out;
}

// The shape of a playlist row. Counts and covers come from the live entries only.
function playlistShape(playlist: typeof playlists.$inferSelect) {
  const rows = liveEntries(db, playlist.id);
  return {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    sourceUrl: playlist.source_url,
    trackCount: rows.length,
    durationMs: rows.reduce((sum, row) => sum + row.length, 0),
    coverArtUrls: [
      ...new Set(
        rows
          .map((row) => coverRoute(row.releaseGroupId, row.cover, "small"))
          .filter((url): url is string => Boolean(url)),
      ),
    ].slice(0, 4),
    createdAt: playlist.created_at.getTime(),
    updatedAt: playlist.updated_at.getTime(),
  };
}

const server = Bun.serve({
  // `routes` requires Bun v1.2.3+
  routes: {
    // Bun bundles the React client and its Tailwind stylesheet.
    "/": index,
    "/config": () =>
      Response.json({ SHOW_MODAL: Bun.env.DEMO_MODE === "true" }),
    "/public/*": async (req) => {
      const files = await readdir("./public");

      const path = new URL(req.url).pathname.replace("/public/", "");
      const file = Bun.file(`./public/${path}`);

      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(file);
    },
    // Cover art from the local cache. A missing file is downloaded first. The URL
    // never changes for a release group, so browsers may keep the image for a year.
    "/covers/:id/:size": async (req) => {
      const { id, size } = req.params;
      if (size !== "small" && size !== "large") {
        return new Response("Not found", { status: 404 });
      }
      if (!(await ensureCover(id, size)).cached) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(Bun.file(coverFilePath(id, size)), {
        headers: { "Cache-Control": "public, max-age=31536000, immutable" },
      });
    },
    // return the content for the home page
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
    // return the content for the artists page (all artists in db)
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
    // return the content for the albums page (all release groups in db)
    "/release-groups": async () => {
      try {
        const allReleaseGroups = db
          .select()
          .from(release_groups)
          .all()
          .map((rg) => ({
            ...rg,
            cover_art_url: coverRoute(rg.id, rg.cover_art_url, "large"),
            cover_art_url_thumbnail_large: coverRoute(
              rg.id,
              rg.cover_art_url_thumbnail_large,
              "large",
            ),
            cover_art_url_thumbnail_small: coverRoute(
              rg.id,
              rg.cover_art_url_thumbnail_small,
              "small",
            ),
          }));
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
    // return the content for per album page (tracks in release group)
    "/release-groups/:id/tracks": async (req) => {
      try {
        const data = fetchReleaseWithTracks(req.params.id);
        return Response.json({ data: data });
      } catch (error) {
        return routeDbError(
          "route_db_read_failed",
          "/release-groups/:id/tracks",
          req,
          error,
        );
      }
    },
    // return the content for per artist page (tracks in artist)
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
    // skip to next track in queue, and refill queue if necessary
    "/tracks/next": async (req) => {
      try {
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
      } catch (error) {
        return routeDbError(
          "route_db_write_failed",
          "/tracks/next",
          req,
          error,
        );
      }
    },
    // skip to previous track in queue, and refill queue if necessary (currently only restarts the current track)
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
    // add a release group to the queue
    "/release-groups/:id/queue": blockInDemo(async (req) => {
      const releaseGroupId = req.params.id;

      if (!releaseGroupId) {
        return new Response("Missing release group id", { status: 400 });
      }

      try {
        // Album order, same as /release-groups/:id/tracks. Unnumbered tracks come
        // last, in insertion order.
        const albumTrackIds = db
          .select({ id: tracks.id })
          .from(tracks)
          .where(eq(tracks.release_group_id, releaseGroupId))
          .orderBy(
            sql`${tracks.disc_number} is null`,
            tracks.disc_number,
            sql`${tracks.track_number} is null`,
            tracks.track_number,
            sql`rowid`,
          )
          .all()
          .map((t) => t.id);

        const firstTrackId = insertTracksAtQueueTop(albumTrackIds, {
          shuffle: isShuffle(req),
        });

        return Response.json({ data: { track_id: firstTrackId } });
      } catch (error) {
        if (error instanceof UnknownTracksError)
          return Response.json(
            { message: error.message, unknownIds: error.unknownIds },
            { status: 400 },
          );
        return routeDbError(
          "route_db_write_failed",
          "/release-groups/:id/queue",
          req,
          error,
        );
      }
    }),
    // put tracks at the top of the queue ("play all", "shuffle", "play next")
    "/queue/tracks": {
      POST: blockInDemo(async (req) => {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return Response.json(
            { message: "invalid or empty JSON body" },
            { status: 400 },
          );
        }
        const trackIds = body?.trackIds;
        if (
          !Array.isArray(trackIds) ||
          trackIds.length === 0 ||
          trackIds.length > 1000 ||
          !trackIds.every((id) => typeof id === "string" && id.length > 0)
        )
          return Response.json(
            { message: "trackIds must be 1 to 1000 non-empty strings" },
            { status: 400 },
          );
        if (body.shuffle !== undefined && typeof body.shuffle !== "boolean")
          return Response.json(
            { message: "shuffle must be a boolean" },
            { status: 400 },
          );

        try {
          const firstTrackId = insertTracksAtQueueTop(trackIds, {
            shuffle: body.shuffle === true,
          });
          return Response.json({ data: { track_id: firstTrackId } });
        } catch (error) {
          if (error instanceof UnknownTracksError)
            return Response.json(
              { message: error.message, unknownIds: error.unknownIds },
              { status: 400 },
            );
          return routeDbError(
            "route_db_write_failed",
            "/queue/tracks",
            req,
            error,
          );
        }
      }),
    },
    // Up Next tap-to-play: drop the rows above `position` and play that row
    "/queue/play-from": {
      POST: blockInDemo(async (req) => {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return Response.json(
            { message: "invalid or empty JSON body" },
            { status: 400 },
          );
        }
        const position = body?.position;
        if (typeof position !== "number" || !Number.isFinite(position))
          return Response.json(
            { message: "position must be a finite number" },
            { status: 400 },
          );

        try {
          const played = playFromQueuePosition(position);
          if (!played)
            return Response.json(
              { message: "queue row not found" },
              { status: 404 },
            );
          return Response.json({ data: { track_id: played.track_id } });
        } catch (error) {
          return routeDbError(
            "route_db_write_failed",
            "/queue/play-from",
            req,
            error,
          );
        }
      }),
    },
    // search for tracks by track title, artist, or release group name
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
    // return the content for the queue page (all tracks in queue)
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
    // return the metadata for a track
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
    // toggle like status for a track
    "/tracks/:id/like": blockInDemo(async (req) => {
      try {
        const trackId = req.params.id;
        if (!trackId) {
          return new Response("Missing Track id", { status: 400 });
        }

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
      } catch (error) {
        return routeDbError(
          "route_db_write_failed",
          "/tracks/:id/like",
          req,
          error,
        );
      }
    }),
    // stream a track
    "/tracks/:id/stream": async (req) => {
      // enable long-lived streaming connections
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
        try {
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
        } catch (error) {
          return routeDbError(
            "route_db_write_failed",
            "/tracks/:id/stream",
            req,
            error,
          );
        }
      }

      // Build the response body. .slice() returns a lazy view — no full read into memory.
      const body = isPartial ? audioFile.slice(start, end + 1) : audioFile;

      const headers: Record<string, string> = {
        "Content-Type": audioContentType(track.filePath),
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
    "/playlists": {
      GET: (req) => {
        try {
          const rows = db
            .select()
            .from(playlists)
            .orderBy(desc(playlists.updated_at))
            .all();
          const data = rows.map(playlistShape);
          return Response.json({ count: data.length, data });
        } catch (error) {
          return routeDbError("route_db_read_failed", "/playlists", req, error);
        }
      },
      POST: blockInDemo(async (req) => {
        const body = await jsonObjectBody(req);
        if (!body) return invalidJsonBody();
        try {
          if (typeof body.name !== "string" || !body.name.trim())
            return Response.json(
              { message: "name is required" },
              { status: 400 },
            );
          const row = db
            .insert(playlists)
            .values({
              name: body.name.trim(),
              description: body.description ?? null,
            })
            .returning()
            .get();
          return Response.json({ data: playlistShape(row) }, { status: 201 });
        } catch (error) {
          return routeDbError(
            "route_db_write_failed",
            "/playlists",
            req,
            error,
          );
        }
      }),
    },
    "/playlists/:id": {
      GET: (req) => {
        try {
          const row = db
            .select()
            .from(playlists)
            .where(eq(playlists.id, String(req.params.id)))
            .get();
          if (!row)
            return Response.json(
              { message: "playlist not found" },
              { status: 404 },
            );
          const entries = liveEntries(db, row.id);
          const trackMap = new Map(
            fetchTracksWithMetadata({
              trackIds: entries.map((entry) => entry.trackId),
            }).map((track) => [track.id, track]),
          );
          return Response.json({
            data: {
              ...playlistShape(row),
              tracks: entries.flatMap((entry) => {
                const track = trackMap.get(entry.trackId);
                return track
                  ? [
                      {
                        entryId: entry.id,
                        position: entry.position,
                        addedAt: entry.createdAt.getTime(),
                        track,
                      },
                    ]
                  : [];
              }),
            },
          });
        } catch (error) {
          return routeDbError(
            "route_db_read_failed",
            "/playlists/:id",
            req,
            error,
          );
        }
      },
      PATCH: blockInDemo(async (req) => {
        const body = await jsonObjectBody(req);
        if (!body) return invalidJsonBody();
        if (
          body.name !== undefined &&
          (typeof body.name !== "string" || !body.name.trim())
        )
          return Response.json(
            { message: "name is required" },
            { status: 400 },
          );
        try {
          const current = db
            .select()
            .from(playlists)
            .where(eq(playlists.id, String(req.params.id)))
            .get();
          if (!current)
            return Response.json(
              { message: "playlist not found" },
              { status: 404 },
            );
          const row = db
            .update(playlists)
            .set({
              name: body.name === undefined ? current.name : body.name.trim(),
              description:
                body.description === undefined
                  ? current.description
                  : body.description,
              updated_at: new Date(),
            })
            .where(eq(playlists.id, current.id))
            .returning()
            .get();
          return Response.json({ data: playlistShape(row) });
        } catch (error) {
          return routeDbError(
            "route_db_write_failed",
            "/playlists/:id",
            req,
            error,
          );
        }
      }),
      DELETE: blockInDemo(async (req) => {
        try {
          // The connection does not enforce foreign keys, so the cascade and set-null
          // from the schema do not run. Do both by hand, in one transaction.
          const playlistId = String(req.params.id);
          db.transaction((tx) => {
            tx.delete(playlist_tracks)
              .where(eq(playlist_tracks.playlist_id, playlistId))
              .run();
            tx.update(imports)
              .set({ playlist_id: null, updated_at: new Date() })
              .where(eq(imports.playlist_id, playlistId))
              .run();
            tx.delete(playlists).where(eq(playlists.id, playlistId)).run();
          });
          return new Response(null, { status: 204 });
        } catch (error) {
          return routeDbError(
            "route_db_write_failed",
            "/playlists/:id",
            req,
            error,
          );
        }
      }),
    },
    "/playlists/:id/tracks": {
      POST: blockInDemo(async (req) => {
        const body = await jsonObjectBody(req);
        if (!body) return invalidJsonBody();
        if (
          !Array.isArray(body.trackIds) ||
          body.trackIds.some((id: unknown) => typeof id !== "string")
        )
          return Response.json(
            { message: "trackIds must be an array" },
            { status: 400 },
          );
        const playlistId = String(req.params.id);
        const trackIds: string[] = body.trackIds;
        try {
          // Checks and inserts share one transaction, so nothing is written when a
          // check fails.
          const outcome = db.transaction((tx) => {
            const exists = tx
              .select({ id: playlists.id })
              .from(playlists)
              .where(eq(playlists.id, playlistId))
              .get();
            if (!exists)
              return { status: 404, message: "playlist not found" } as const;

            const unique = [...new Set(trackIds)];
            const known = new Set(
              unique.length > 0
                ? tx
                    .select({ id: tracks.id })
                    .from(tracks)
                    .where(inArray(tracks.id, unique))
                    .all()
                    .map((row) => row.id)
                : [],
            );
            const unknownIds = unique.filter((id) => !known.has(id));
            if (unknownIds.length > 0)
              return {
                status: 400,
                message: `unknown track ids: ${unknownIds.join(", ")}`,
                unknownIds,
              } as const;

            // Duplicates are allowed, the same track can appear twice in a playlist.
            const base = highestPlaylistPosition(tx, playlistId);
            const now = new Date();
            const rows = trackIds.map((trackId, i) => ({
              playlist_id: playlistId,
              track_id: trackId,
              position: base + 1 + i,
              created_at: now,
              updated_at: now,
            }));
            const inserted = rows.length
              ? tx.insert(playlist_tracks).values(rows).returning().all()
              : [];
            return { inserted } as const;
          });
          if ("message" in outcome)
            return Response.json(
              "unknownIds" in outcome
                ? { message: outcome.message, unknownIds: outcome.unknownIds }
                : { message: outcome.message },
              { status: outcome.status },
            );

          const trackMap = new Map(
            fetchTracksWithMetadata({
              trackIds: outcome.inserted.map((entry) => entry.track_id),
            }).map((track) => [track.id, track]),
          );
          return Response.json({
            data: outcome.inserted.flatMap((entry) => {
              const track = trackMap.get(entry.track_id);
              return track
                ? [
                    {
                      entryId: entry.id,
                      position: entry.position,
                      addedAt: entry.created_at.getTime(),
                      track,
                    },
                  ]
                : [];
            }),
          });
        } catch (error) {
          return routeDbError(
            "route_db_write_failed",
            "/playlists/:id/tracks",
            req,
            error,
          );
        }
      }),
    },
    "/playlists/:id/tracks/:entryId": {
      DELETE: blockInDemo(async (req) => {
        try {
          // Matches the playlist as well as the entry, so an entry of another playlist is a 404.
          const removed = db
            .delete(playlist_tracks)
            .where(
              and(
                eq(playlist_tracks.id, String(req.params.entryId)),
                eq(playlist_tracks.playlist_id, String(req.params.id)),
              ),
            )
            .returning({ id: playlist_tracks.id })
            .all();
          if (removed.length === 0)
            return Response.json(
              { message: "entry not found" },
              { status: 404 },
            );
          return new Response(null, { status: 204 });
        } catch (error) {
          return routeDbError(
            "route_db_write_failed",
            "/playlists/:id/tracks/:entryId",
            req,
            error,
          );
        }
      }),
      PATCH: blockInDemo(async (req) => {
        const body = await jsonObjectBody(req);
        if (!body) return invalidJsonBody();
        if (body.afterEntryId === undefined)
          return Response.json(
            { message: "afterEntryId is required" },
            { status: 400 },
          );
        if (body.afterEntryId !== null && typeof body.afterEntryId !== "string")
          return Response.json(
            { message: "afterEntryId must be a string or null" },
            { status: 400 },
          );
        const playlistId = String(req.params.id);
        const entryId = String(req.params.entryId);
        try {
          const outcome = db.transaction((tx) => {
            const exists = tx
              .select({ id: playlists.id })
              .from(playlists)
              .where(eq(playlists.id, playlistId))
              .get();
            if (!exists)
              return { status: 404, message: "playlist not found" } as const;

            // Ghost rows still hold positions, so they take part in ordering and the
            // unique index. Only live entries can be moved.
            const all = tx
              .select()
              .from(playlist_tracks)
              .where(eq(playlist_tracks.playlist_id, playlistId))
              .orderBy(playlist_tracks.position)
              .all();
            const liveIds = new Set(
              liveEntries(tx, playlistId).map((entry) => entry.id),
            );
            const moving = all.find((entry) => entry.id === entryId);
            if (!moving || !liveIds.has(moving.id))
              return { status: 404, message: "entry not found" } as const;

            const rest = all.filter((entry) => entry.id !== moving.id);
            const afterIndex =
              body.afterEntryId === null
                ? -1
                : rest.findIndex((entry) => entry.id === body.afterEntryId);
            if (body.afterEntryId !== null && afterIndex < 0)
              return {
                status: 400,
                message: "afterEntryId not found",
              } as const;
            const before = rest[afterIndex];
            const next = rest[afterIndex + 1];

            const slots = pendingJobSlots(tx, playlistId);
            const candidate =
              before && next
                ? (before.position + next.position) / 2
                : before
                  ? before.position + 1
                  : next
                    ? next.position - 1
                    : 0;
            const targetSegment = before
              ? segmentOf(before.position, slots)
              : 0;
            // The midpoint can hit a neighbour or a pending slot once a gap has been
            // halved many times, or the anchor moves the entry across a slot.
            const fits =
              (!before || candidate > before.position) &&
              (!next || candidate < next.position) &&
              (!before || !next || next.position - before.position >= 1e-9) &&
              !slots.includes(candidate) &&
              segmentOf(candidate, slots) === targetSegment;

            const newPositions = new Map<string, number>();
            if (fits) {
              newPositions.set(moving.id, candidate);
            } else {
              const ordered = [
                ...rest.slice(0, afterIndex + 1),
                moving,
                ...rest.slice(afterIndex + 1),
              ];
              const segments = ordered.map((entry) =>
                entry === moving
                  ? targetSegment
                  : segmentOf(entry.position, slots),
              );
              const positions = renumberPositions(segments, slots);
              ordered.forEach((entry, i) =>
                newPositions.set(entry.id, positions[i]!),
              );
            }

            const now = new Date();
            const changed = all.filter(
              (entry) =>
                newPositions.has(entry.id) &&
                newPositions.get(entry.id) !== entry.position,
            );
            // Two passes: each row first moves off the positions it holds now, so the
            // unique index never sees two rows on one position.
            changed.forEach((entry, i) =>
              tx
                .update(playlist_tracks)
                .set({ position: -1e15 - i })
                .where(eq(playlist_tracks.id, entry.id))
                .run(),
            );
            for (const entry of changed)
              tx.update(playlist_tracks)
                .set({
                  position: newPositions.get(entry.id)!,
                  updated_at: now,
                })
                .where(eq(playlist_tracks.id, entry.id))
                .run();

            return {
              trackId: moving.track_id,
              position: newPositions.get(moving.id)!,
              addedAt: moving.created_at.getTime(),
            };
          });
          if ("status" in outcome)
            return Response.json(
              { message: outcome.message },
              { status: outcome.status },
            );

          const track = fetchTracksWithMetadata({
            trackId: outcome.trackId,
          })[0];
          return Response.json({
            data: {
              entryId,
              position: outcome.position,
              addedAt: outcome.addedAt,
              track,
            },
          });
        } catch (error) {
          return routeDbError(
            "route_db_write_failed",
            "/playlists/:id/tracks/:entryId",
            req,
            error,
          );
        }
      }),
    },
    "/playlists/:id/queue": {
      POST: blockInDemo(async (req) => {
        try {
          const playlistId = String(req.params.id);
          const exists = db
            .select({ id: playlists.id })
            .from(playlists)
            .where(eq(playlists.id, playlistId))
            .get();
          if (!exists)
            return Response.json(
              { message: "playlist not found" },
              { status: 404 },
            );
          const entries = liveEntries(db, playlistId);
          if (entries.length === 0)
            return Response.json(
              { message: "playlist has no tracks" },
              { status: 400 },
            );
          const firstTrackId = insertTracksAtQueueTop(
            entries.map((entry) => entry.trackId),
            { shuffle: isShuffle(req) },
          );
          return Response.json({ data: { track_id: firstTrackId } });
        } catch (error) {
          if (error instanceof UnknownTracksError)
            return Response.json(
              { message: error.message, unknownIds: error.unknownIds },
              { status: 400 },
            );
          return routeDbError(
            "route_db_write_failed",
            "/playlists/:id/queue",
            req,
            error,
          );
        }
      }),
    },
    "/import/preview": {
      POST: async (req) => {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return Response.json(
            { message: "invalid or empty JSON body" },
            { status: 400 },
          );
        }
        const url = body?.url;
        if (typeof url !== "string" || !url.trim())
          return Response.json({ message: "no url sent" }, { status: 400 });
        try {
          const { data } = await analyzeImportUrl(url);
          return Response.json({ data });
        } catch (error) {
          if (error instanceof InvalidImportUrlError)
            return Response.json({ message: error.message }, { status: 400 });
          await logIngestFailure("import_preview_failed", error, {
            stage: "preview",
          });
          // A yt-dlp call that hit its time limit is a gateway timeout, not a server bug.
          if (error instanceof CommandError && error.errorKind === "timeout")
            return Response.json(
              {
                message: "timed out while reading this YouTube URL, try again",
              },
              { status: 504 },
            );
          return Response.json(
            { message: "failed to preview import" },
            { status: 500 },
          );
        }
      },
    },
    "/imports": {
      GET: (req) => {
        try {
          // Default 20, at most 100. A missing or non-numeric limit is the default.
          const raw = new URL(req.url).searchParams.get("limit");
          const requested =
            raw === null || raw.trim() === "" ? NaN : Number(raw);
          const limit = Number.isFinite(requested)
            ? Math.max(1, Math.min(100, Math.floor(requested)))
            : 20;
          const rows = db
            .select()
            .from(imports)
            .orderBy(desc(imports.created_at))
            .limit(limit)
            .all();
          const data = rows.map((row) => {
            const grouped = db
              .select({ status: jobs.status, count: sql<number>`count(*)` })
              .from(jobs)
              .where(eq(jobs.import_id, row.id))
              .groupBy(jobs.status)
              .all();
            const counts = { queued: 0, running: 0, completed: 0, failed: 0 };
            for (const item of grouped)
              if (item.status in counts)
                counts[item.status as keyof typeof counts] = item.count;
            return {
              id: row.id,
              mode: row.mode,
              title: row.title,
              sourceUrl: row.source_url,
              playlistId: row.playlist_id,
              createdAt: row.created_at.getTime(),
              counts,
            };
          });
          return Response.json({ data });
        } catch (error) {
          return routeDbError("route_db_read_failed", "/imports", req, error);
        }
      },
    },
    "/imports/:id": {
      GET: (req) => {
        try {
          const row = db
            .select()
            .from(imports)
            .where(eq(imports.id, String(req.params.id)))
            .get();
          if (!row)
            return Response.json(
              { message: "import not found" },
              { status: 404 },
            );
          const grouped = db
            .select({ status: jobs.status, count: sql<number>`count(*)` })
            .from(jobs)
            .where(eq(jobs.import_id, row.id))
            .groupBy(jobs.status)
            .all();
          const counts = { queued: 0, running: 0, completed: 0, failed: 0 };
          for (const item of grouped)
            if (item.status in counts)
              counts[item.status as keyof typeof counts] = item.count;
          const jobRows = db
            .select()
            .from(jobs)
            .where(eq(jobs.import_id, row.id))
            .orderBy(jobs.position)
            .all();
          return Response.json({
            data: {
              id: row.id,
              mode: row.mode,
              title: row.title,
              sourceUrl: row.source_url,
              playlistId: row.playlist_id,
              createdAt: row.created_at.getTime(),
              counts,
              jobs: jobRows.map((job) => ({
                id: job.id,
                position: job.position,
                status: job.status,
                error: job.error,
                trackId: job.track_id,
              })),
            },
          });
        } catch (error) {
          return routeDbError(
            "route_db_read_failed",
            "/imports/:id",
            req,
            error,
          );
        }
      },
    },
    // handle importing a track from a URL
    "/import": blockInDemo(async (req) => {
      const requestId = randomUUID();
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
      } catch (error) {
        await logIngestFailure("import_invalid_json", error, {
          requestId,
          stage: "request_validation",
        });
        return Response.json(
          { message: "invalid or empty JSON body" },
          { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }

      const url = body?.url;

      if (typeof url !== "string" || url.trim().length === 0) {
        await logIngestFailure(
          "import_url_missing_or_invalid",
          new Error("Expected a non-empty URL string in request body"),
          { requestId, stage: "request_validation" },
        );
        return Response.json(
          {
            message: "no url sent",
          },
          {
            headers: {
              "Access-Control-Allow-Origin": "*",
            },
            status: 400,
          },
        );
      }

      // Only YouTube URLs get past here. The playlist URL is rebuilt from its list id,
      // so yt-dlp never sees the raw input.
      let normalized: ReturnType<typeof normalizeImportUrl>;
      try {
        normalized = normalizeImportUrl(url);
      } catch (error) {
        await logIngestFailure("import_url_rejected", error, {
          requestId,
          stage: "request_validation",
        });
        return Response.json(
          { message: (error as Error).message },
          {
            status: 400,
            headers: { "Access-Control-Allow-Origin": "*" },
          },
        );
      }

      logIngestSuccess("import_received", {
        requestId,
        isPlaylist: normalized.isPlaylist,
      });
      let urls: string[];
      let analysis: ImportAnalysis | null = null;
      let resolvedMode: "single" | "album" | "playlist" = "single";
      let resolvedTitle: string | null = body.title ?? null;
      let resolvedReleaseId: string | null = body.releaseId ?? null;
      try {
        // Playlists go through the same analysis as POST /import/preview, so auto mode
        // makes the same album-or-playlist decision and recommends the same pressing.
        analysis = normalized.isPlaylist
          ? await analyzeImportUrl(normalized.url, requestId)
          : null;
        urls =
          analysis?.entryUrls ??
          (await getAllUrlsFromPlaylist(normalized.url, requestId));
        const requestedMode = body.mode;
        const modeIsRequested =
          requestedMode === "single" ||
          requestedMode === "album" ||
          requestedMode === "playlist";
        if (modeIsRequested) resolvedMode = requestedMode;
        else if (analysis)
          resolvedMode = analysis.data.kind === "album" ? "album" : "playlist";
        if (analysis) resolvedTitle = resolvedTitle ?? analysis.data.title;
        const recommendation = analysis?.data.recommendation;
        if (resolvedMode === "album" && recommendation?.mode === "album")
          resolvedReleaseId = resolvedReleaseId ?? recommendation.releaseId;
      } catch (error) {
        await logIngestFailure("import_playlist_expansion_failed", error, {
          requestId,
          stage: "playlist_expansion",
        });
        return Response.json(
          { message: "failed to create import jobs" },
          { status: 500, headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }

      const urlCount = urls.length;
      if (urlCount === 0) {
        await logIngestFailure(
          "import_playlist_empty",
          new Error("Playlist expansion returned no video URLs"),
          { requestId, stage: "playlist_expansion" },
        );
        return Response.json(
          { message: "playlist did not contain any importable videos" },
          { status: 422, headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }

      const mode = resolvedMode;
      const releaseGroupId =
        mode === "album" && resolvedReleaseId
          ? await releaseGroupIdForRelease(
              resolvedReleaseId,
              analysis?.data.albumCandidates ?? [],
              requestId,
            )
          : null;

      let jobIds: string[] = [];
      let importId = "";
      let playlistId: string | null = null;
      try {
        const now = new Date();
        db.transaction((tx) => {
          if (body.playlist?.create === true) {
            playlistId = tx
              .insert(playlists)
              .values({
                name: body.playlist.name || resolvedTitle || normalized.url,
                source_url: normalized.url,
              })
              .returning({ id: playlists.id })
              .get().id;
          }
          importId = tx
            .insert(imports)
            .values({
              source_url: normalized.url,
              mode,
              title: resolvedTitle,
              musicbrainz_release_id:
                mode === "album" ? resolvedReleaseId : null,
              musicbrainz_release_group_id: releaseGroupId,
              playlist_id: playlistId,
              created_at: now,
              updated_at: now,
            })
            .returning({ id: imports.id })
            .get().id;
          jobIds = urls.map(
            (itemUrl, position) =>
              tx
                .insert(jobs)
                .values({ url: itemUrl, import_id: importId, position })
                .returning({ id: jobs.id })
                .get().id,
          );
        });
      } catch (error) {
        await logIngestFailure("import_queue_creation_failed", error, {
          requestId,
          stage: "queue_creation",
          urlCount,
        });
        return Response.json(
          { message: "failed to create import jobs" },
          { status: 500, headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }

      // Job ids let a job be traced back to this import (worker records carry jobId).
      await logIngestInfo("import_jobs_created", {
        requestId,
        importId,
        jobCount: jobIds.length,
        jobIds,
      });

      return Response.json(
        {
          data: { importId, jobCount: jobIds.length, playlistId },
          message: "created jobs to ingest tracks",
        },
        {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }),
  },
  hostname: Bun.env.BIND_HOST ?? "127.0.0.1",
  port: Bun.env.BIND_PORT ?? 8080,
  // Bun's hot reload refuses any Host header but the bind address, which blocks
  // Tailscale hostnames. `bun run dev` restarts on file changes, so it is not needed.
  development: Bun.env.NODE_ENV === "production" ? false : { hmr: false },
  // (optional) fallback for unmatched routes:
  // Required if Bun's version < 1.2.3
  fetch(req) {
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server running at ${server.url}`);
