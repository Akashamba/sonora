import { eq, inArray, or } from "drizzle-orm";
import { artists, release_groups, track_artists, tracks } from "../schema";
import { db } from "..";
import type { TrackResponse } from "~/types/api/Track";

export function fetchTracksWithMetadata(opts?: {
  trackIds?: string[];
  trackId?: string;
}): TrackResponse[] {
  const conditions = [];

  if (opts?.trackId) {
    conditions.push(eq(tracks.id, opts.trackId));
  }

  if (opts?.trackIds) {
    conditions.push(inArray(tracks.id, opts.trackIds));
  }

  const rows = db
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
      releaseGroupCoverArt: release_groups.cover_art_url,
      releaseGroupThumbnail: release_groups.cover_art_url_thumbnail_small,
    })
    .from(tracks)
    .where(conditions.length > 0 ? or(...conditions) : undefined)
    .leftJoin(track_artists, eq(track_artists.track_id, tracks.id))
    .leftJoin(artists, eq(artists.id, track_artists.artist_id))
    .leftJoin(release_groups, eq(release_groups.id, tracks.release_group_id))
    .all();

  const tracksMap = new Map<string, TrackResponse>();

  for (const row of rows) {
    if (!tracksMap.has(row.trackId)) {
      tracksMap.set(row.trackId, {
        id: row.trackId,
        title: row.trackTitle,
        length: row.trackLength,
        release_group: {
          id: row.releaseGroupId!,
          title: row.releaseGroupTitle!,
          cover_art_url: row.releaseGroupCoverArt,
          cover_art_url_thumbnail_small: row.releaseGroupThumbnail,
        },
        artists: [],
      });
    }

    if (row.artistId) {
      tracksMap.get(row.trackId)?.artists.push({
        id: row.artistId,
        name: row.artistName!,
        pos: row.artistPosition!,
        joinphrase: row.artistJoinphrase,
      });
    }
  }

  return Array.from(tracksMap.values());
}
