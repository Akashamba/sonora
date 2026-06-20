import { eq } from "drizzle-orm";
import { artists, release_groups, track_artists, tracks } from "../schema";
import { db } from "..";
import type { ReleaseGroupResponse } from "~/types/api/ReleaseGroup";

export function fetchReleaseWithTracks(id: string): ReleaseGroupResponse {
  const rows = db
    .select({
      releaseGroupsId: release_groups.id,
      releaseGroupsTitle: release_groups.title,
      releaseGroupsPrimaryType: release_groups.musicbrainz_primary_type,
      releaseGroupsCoverArtUrl: release_groups.cover_art_url,
      releaseGroupFirstReleaseDate: release_groups.first_release_date,
      trackId: tracks.id,
      trackTitle: tracks.title,
      trackLength: tracks.length,
      artistId: artists.id,
      artistName: artists.name,
      artistPosition: track_artists.pos,
      artistJoinphrase: track_artists.joinphrase,
    })
    .from(release_groups)
    .where(eq(release_groups.id, id))
    .leftJoin(tracks, eq(tracks.release_group_id, release_groups.id))
    .leftJoin(track_artists, eq(track_artists.track_id, tracks.id))
    .leftJoin(artists, eq(artists.id, track_artists.artist_id))
    .all();

  const releaseGroup = {
    id: rows[0]?.releaseGroupsId!,
    title: rows[0]?.releaseGroupsTitle!,
    primary_type: rows[0]?.releaseGroupsPrimaryType!,
    cover_art_url: rows[0]?.releaseGroupsCoverArtUrl!,
    first_release_date: rows[0]?.releaseGroupFirstReleaseDate!,
    tracks: [] as any[],
  };

  // Use a Map to deduplicate tracks, keying by track ID
  const trackMap = new Map<string, any>();

  rows.forEach((row) => {
    if (!row.trackId) return;

    if (!trackMap.has(row.trackId)) {
      trackMap.set(row.trackId, {
        id: row.trackId,
        title: row.trackTitle,
        length: row.trackLength,
        artists: [],
      });
    }

    // Append each artist to the track's artists array
    if (row.artistId) {
      trackMap.get(row.trackId).artists.push({
        id: row.artistId,
        name: row.artistName,
        position: row.artistPosition,
        joinphrase: row.artistJoinphrase,
      });
    }
  });

  // Sort artists by position so they appear in the right order
  releaseGroup.tracks = Array.from(trackMap.values()).map((track) => ({
    ...track,
    artists: track.artists.sort(
      (a: any, b: any) => (a.position ?? 0) - (b.position ?? 0),
    ),
  }));

  return releaseGroup;
}
