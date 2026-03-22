import { desc, eq, inArray, like, or } from "drizzle-orm";
import {
  artists,
  play_counts,
  release_groups,
  track_artists,
  tracks,
} from "../schema";
import { db } from "..";
import type { TrackResponse } from "~/types/api/Track";

export function fetchTracksWithMetadata(opts?: {
  trackIds?: string[];
  trackId?: string;
  topTracks?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
}): TrackResponse[] {
  const conditions = [];

  if (opts?.trackId) {
    conditions.push(eq(tracks.id, opts.trackId));
  }

  if (opts?.trackIds) {
    conditions.push(inArray(tracks.id, opts.trackIds));
  }

  if (opts?.topTracks) {
    const topTrackIds = db
      .select({ id: tracks.id })
      .from(tracks)
      .leftJoin(play_counts, eq(play_counts.track_id, tracks.id))
      .orderBy(desc(play_counts.count))
      .limit(30)
      .all();

    conditions.push(
      inArray(
        tracks.id,
        topTrackIds.map((t) => t.id),
      ),
    );
  }

  if (opts?.query) {
    const matches = db
      .select({ id: tracks.id })
      .from(tracks)
      .leftJoin(release_groups, eq(release_groups.id, tracks.release_group_id))
      .leftJoin(track_artists, eq(track_artists.track_id, tracks.id))
      .leftJoin(artists, eq(artists.id, track_artists.artist_id))
      .where(
        or(
          like(tracks.title, `%${opts.query}%`),
          like(release_groups.title, `%${opts.query}%`),
          like(artists.name, `%${opts.query}%`),
        ),
      )
      .groupBy(tracks.id)
      .limit(opts?.limit ?? 50)
      .offset(opts?.offset ?? 0)
      .all();

    conditions.push(
      inArray(
        tracks.id,
        matches.map((t) => t.id),
      ),
    );
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
