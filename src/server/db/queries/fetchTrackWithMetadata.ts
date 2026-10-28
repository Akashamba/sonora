import {
  desc,
  eq,
  inArray,
  isNotNull,
  like,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  artists,
  history,
  play_stats,
  queue,
  release_groups,
  track_artists,
  tracks,
} from "../schema";
import { db } from "..";
import type { TrackResponse } from "~/types/api/Track";

// SQLite's default variable limit is 32766 in recent versions. Chunking keeps every
// IN list well under that, even on older builds. Queries are merged in JS, so order
// comes from the caller's sort, not from SQL.
const ID_CHUNK_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

export function fetchTracksWithMetadata(opts?: {
  trackIds?: string[];
  trackId?: string;
  topTracks?: boolean;
  recentTracks?: boolean;
  queueTracks?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
}): TrackResponse[] {
  // Conditions that are ORed together. trackIds is handled per chunk below.
  const conditions: SQL[] = [];

  if (opts?.trackId) {
    conditions.push(eq(tracks.id, opts.trackId));
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

  // The 10 most recently played distinct tracks, newest first.
  const recent = opts?.recentTracks
    ? db
        .select({ track_id: history.track_id })
        .from(history)
        .where(isNotNull(history.track_id))
        .groupBy(history.track_id)
        .orderBy(desc(sql`max(${history.id})`))
        .limit(10)
        .all()
    : [];
  if (opts?.recentTracks) {
    conditions.push(
      inArray(
        tracks.id,
        recent.map((t) => t.track_id!),
      ),
    );
  }

  // Each pass is one SELECT. A trackIds lookup runs one pass per chunk of ids.
  const idChunks = opts?.trackIds
    ? chunk([...new Set(opts.trackIds)], ID_CHUNK_SIZE)
    : [];
  if (opts?.trackIds && idChunks.length === 0 && conditions.length === 0) {
    return [];
  }
  const passes: SQL[][] =
    idChunks.length > 0
      ? idChunks.map((ids) => [...conditions, inArray(tracks.id, ids)])
      : [conditions];
  // Filtered lookups are bounded by their own inputs (ids, search limit, recent
  // list), so only an unfiltered read gets the fallback cap.
  const filtered = conditions.length > 0 || opts?.trackIds !== undefined;
  const rowLimit = opts?.topTracks
    ? 10
    : filtered
      ? Number.MAX_SAFE_INTEGER
      : 50;

  const trackRows = passes.flatMap((pass) =>
    db
      .select({
        trackId: tracks.id,
        trackTitle: tracks.title,
        trackLength: tracks.length,
        releaseGroupId: release_groups.id,
        releaseGroupTitle: release_groups.title,
        releaseGroupCoverArt: release_groups.cover_art_url,
        releaseGroupThumbnail: release_groups.cover_art_url_thumbnail_small,
        liked: play_stats.liked,
        queuePosition: sql<
          number | null
        >`(select min(${queue.position}) from ${queue} where ${queue.track_id} = ${tracks.id})`,
      })
      .from(tracks)
      .leftJoin(play_stats, eq(play_stats.track_id, tracks.id))
      .leftJoin(release_groups, eq(release_groups.id, tracks.release_group_id))
      .where(pass.length > 0 ? or(...pass) : undefined)
      .orderBy(...(opts?.topTracks ? [desc(play_stats.count)] : []))
      .limit(rowLimit)
      .all(),
  );

  // Dedupe across chunks, keeping the first row seen for each track.
  const uniqueRows = new Map<string, (typeof trackRows)[number]>();
  for (const row of trackRows) {
    if (!uniqueRows.has(row.trackId)) uniqueRows.set(row.trackId, row);
  }
  const rows = [...uniqueRows.values()];

  if (opts?.recentTracks) {
    const recentRank = new Map(recent.map((t, i) => [t.track_id, i]));
    rows.sort(
      (a, b) =>
        (recentRank.get(a.trackId) ?? recent.length) -
        (recentRank.get(b.trackId) ?? recent.length),
    );
  }

  const tracksMap = new Map<string, TrackResponse>();

  for (const row of rows) {
    tracksMap.set(row.trackId, {
      id: row.trackId,
      title: row.trackTitle,
      length: row.trackLength,
      liked: row.liked === 1,
      position: row.queuePosition,
      release_group: {
        id: row.releaseGroupId!,
        title: row.releaseGroupTitle!,
        cover_art_url: row.releaseGroupCoverArt,
        cover_art_url_thumbnail_small: row.releaseGroupThumbnail,
      },
      artists: [],
    });
  }

  const trackIdList = [...tracksMap.keys()];
  for (const ids of chunk(trackIdList, ID_CHUNK_SIZE)) {
    // Ordered by pos, so each track's artists come out in credit order.
    const credits = db
      .select({
        trackId: track_artists.track_id,
        artistId: artists.id,
        artistName: artists.name,
        artistPosition: track_artists.pos,
        artistJoinphrase: track_artists.joinphrase,
      })
      .from(track_artists)
      .innerJoin(artists, eq(artists.id, track_artists.artist_id))
      .where(inArray(track_artists.track_id, ids))
      .orderBy(track_artists.pos)
      .all();

    for (const credit of credits) {
      tracksMap.get(credit.trackId!)?.artists.push({
        id: credit.artistId,
        name: credit.artistName,
        pos: credit.artistPosition,
        joinphrase: credit.artistJoinphrase,
      });
    }
  }

  // Up Next: one item per queue row, in queue order, each with its own position. A
  // track queued twice is listed twice. Tracks outside trackIds are skipped.
  if (opts?.queueTracks) {
    const queueRows = db
      .select({ trackId: queue.track_id, position: queue.position })
      .from(queue)
      .orderBy(queue.position)
      .all();
    return queueRows.flatMap((row) => {
      const track = tracksMap.get(row.trackId ?? "");
      return track ? [{ ...track, position: row.position }] : [];
    });
  }

  return Array.from(tracksMap.values());
}
