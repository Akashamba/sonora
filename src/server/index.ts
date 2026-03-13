import { eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { artists, release_groups, track_artists, tracks } from "./db/schema";
import { file } from "bun";
import { getAllUrlsFromPlaylist } from "~/utils/metadata-utils";
import { ingestTrack } from "~/services/ingestTrack";
import { readdirSync, readFileSync } from "fs";

const index = readFileSync("src/app/index.html", "utf8");

const server = Bun.serve({
  // `routes` requires Bun v1.2.3+
  routes: {
    "/": new Response(index, {
      headers: { "Content-Type": "text/html" },
    }),
    "/tracks": async () => {
      const rows = await db
        .select({
          trackId: tracks.id,
          trackTitle: tracks.title,
          trackLength: tracks.length,
          artistId: artists.id,
          artistName: artists.name,
          artistPosition: track_artists.pos,
          artistJoinphrase: track_artists.joinphrase,
          releaseGroupId: release_groups.id,
          releaseGroupTitle: release_groups.title,
        })
        .from(tracks)
        .leftJoin(track_artists, eq(track_artists.track_id, tracks.id))
        .leftJoin(artists, eq(artists.id, track_artists.artist_id))
        .leftJoin(
          release_groups,
          eq(release_groups.id, tracks.release_group_id),
        );

      const tracksMap = new Map();

      for (const row of rows) {
        if (!tracksMap.has(row.trackId)) {
          tracksMap.set(row.trackId, {
            id: row.trackId,
            title: row.trackTitle,
            length: row.trackLength,
            releaseGroup: {
              id: row.releaseGroupId,
              title: row.releaseGroupTitle,
            },
            artists: [],
          });
        }

        if (row.artistId) {
          tracksMap.get(row.trackId).artists.push({
            id: row.artistId,
            name: row.artistName,
            pos: row.artistPosition,
            joinphrase: row.artistJoinphrase,
          });
        }
      }

      const data = Array.from(tracksMap.values());

      return Response.json(
        {
          status: "success",
          count: data.length,
          data: data,
        },
        {
          headers: {
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    },
    "/artists": async () => {
      const allArtists = await db.select().from(artists);
      return Response.json(allArtists, {
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      });
    },
    "/release-groups": async () => {
      const allReleaseGroups = await db.select().from(release_groups);
      return Response.json(allReleaseGroups, {
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      });
    },
    "/release-groups/:id/tracks": async (req) => {
      const { id } = req.params;
      const tracksInReleaseGroup = await db
        .select({
          releaseGroupsId: release_groups.id,
          releaseGroupsTitle: release_groups.title,
          releaseGroupsPrimaryType: release_groups.musicbrainz_primary_type,
          releaseGroupsCoverArtUrl: release_groups.cover_art_url,
          releaseGroupFirstReleaseDate: release_groups.first_release_date,
          trackId: tracks.id,
          trackTitle: tracks.title,
          trackLength: tracks.length,
        })
        .from(release_groups)
        .where(eq(release_groups.id, id))
        .leftJoin(tracks, eq(tracks.release_group_id, release_groups.id));

      if (tracksInReleaseGroup.length === 0) {
        return Response.json(
          {
            status: "success",
            message: "No tracks in this release group",
            count: 0,
          },
          {
            headers: {
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      } else {
        const releaseGroup = {
          id: tracksInReleaseGroup[0]?.releaseGroupsId,
          title: tracksInReleaseGroup[0]?.releaseGroupsTitle,
          primaryType: tracksInReleaseGroup[0]?.releaseGroupsPrimaryType,
          coverArtUrl: tracksInReleaseGroup[0]?.releaseGroupsCoverArtUrl,
          firstReleaseDate:
            tracksInReleaseGroup[0]?.releaseGroupFirstReleaseDate,
          tracks: [] as any[],
        };

        tracksInReleaseGroup.forEach((t) => {
          releaseGroup.tracks.push({
            id: t.trackId,
            title: t.trackTitle,
            length: t.trackLength,
          });
        });

        return Response.json(releaseGroup, {
          headers: {
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    },
    "/artists/:id/tracks": async (req) => {
      const { id } = req.params;
      const allTracks = await db
        .select({ trackId: track_artists.track_id })
        .from(artists)
        .where(eq(artists.id, id))
        .leftJoin(track_artists, eq(track_artists.artist_id, artists.id));

      const rows = await db
        .select({
          trackId: tracks.id,
          trackTitle: tracks.title,
          trackLength: tracks.length,
          artistId: artists.id,
          artistName: artists.name,
          artistPosition: track_artists.pos,
          artistJoinphrase: track_artists.joinphrase,
          releaseGroupId: release_groups.id,
          releaseGroupTitle: release_groups.title,
        })
        .from(tracks)
        .where(
          inArray(
            tracks.id,
            allTracks.map((t) => t.trackId || ""),
          ),
        )
        .leftJoin(track_artists, eq(track_artists.track_id, tracks.id))
        .leftJoin(artists, eq(artists.id, track_artists.artist_id))
        .leftJoin(
          release_groups,
          eq(release_groups.id, tracks.release_group_id),
        );

      const tracksMap = new Map();

      for (const row of rows) {
        if (!tracksMap.has(row.trackId)) {
          tracksMap.set(row.trackId, {
            id: row.trackId,
            title: row.trackTitle,
            length: row.trackLength,
            releaseGroup: {
              id: row.releaseGroupId,
              title: row.releaseGroupTitle,
            },
            artists: [],
          });
        }

        if (row.artistId) {
          tracksMap.get(row.trackId).artists.push({
            id: row.artistId,
            name: row.artistName,
            pos: row.artistPosition,
            joinphrase: row.artistJoinphrase,
          });
        }
      }

      const data = Array.from(tracksMap.values());

      return Response.json(
        {
          status: "success",
          count: data.length,
          data: data,
        },
        {
          headers: {
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    },
    "/tracks/:id/stream": async (req) => {
      const { id } = req.params;

      const [track] = await db
        .select({ filePath: tracks.file_path })
        .from(tracks)
        .where(eq(tracks.id, id));

      if (!track) {
        return new Response("Track not found", { status: 404 });
      }

      const audioFile = file(track.filePath);
      const exists = await audioFile.exists();

      if (!exists) return new Response("File not found", { status: 404 });

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
        for (let url of urls) {
          await ingestTrack(url);
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
    "/stream": async () => {
      const folderPath = "audio"; // replace with your folder

      // Get all file names
      const tracks = readdirSync(folderPath);

      // Pick a random track
      const trackPath = tracks[Math.floor(Math.random() * tracks.length)];

      console.log(`audio/${trackPath}`);

      const audioFile = file(`audio/${trackPath}`);
      const exists = await audioFile.exists();

      if (!exists) {
        console.log("no file");
        return new Response("File not found", { status: 404 });
      }

      return new Response(audioFile, {
        headers: {
          "Content-Type": "audio/mp4",
          "Content-Length": String(audioFile.size),
        },
      });
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
