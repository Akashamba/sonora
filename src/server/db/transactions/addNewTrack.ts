import { db } from "..";
import {
  insertArtist,
  type ArtistType,
} from "~/server/db/queries/insertArtist";
import { insertTrack } from "~/server/db/queries/insertTrack";
import {
  insertTrackArtist,
  type InsertedAristType,
} from "~/server/db/queries/insertTrackArtist";
import { upsertReleaseGroup } from "~/server/db/queries/upsertReleseGroup";
import { describeDateValue } from "~/utils/dateLogging";
import { trackPositionOnRelease } from "~/utils/trackPosition";
import { logIngestFailure, logIngestInfo } from "~/utils/ingestLogger";
import { trackUniqueConflict } from "./trackUniqueConflict";

export interface TrackInfoType {
  release: {
    "release-group": {
      id: string;
      "primary-type": string;
      title: string;
      cover_art_url?: string;
      cover_art_url_thumbnail_large?: string;
      cover_art_url_thumbnail_small?: string;
    };
    date: string;
    // Present only when the release was fetched with its track listing.
    media?: any[];
  };
  youtubeId: string;
  filePath: string;
  recording: {
    id: string;
    title: string;
    "first-release-date": string;
    length: number;
    "artist-credit": ArtistType[];
  };
}

export async function addNewTrack(
  trackInfo: TrackInfoType,
  context: {
    jobId: string;
    musicbrainzLookupId?: string;
    musicbrainzResponseFile?: string;
  },
) {
  let stage = "release_group_upsert";
  let committed: { trackId: string; releaseGroupId: string };
  try {
    // The body must stay synchronous. bun:sqlite commits as soon as the callback
    // returns, so an awaited write here would run outside the transaction. Any
    // lookup or cover-art fetch belongs before this call.
    committed = db.transaction((tx) => {
      // Upsert release group
      const release_group_id = upsertReleaseGroup(tx, trackInfo.release);

      // Insert track
      stage = "track_insert";
      const position = trackPositionOnRelease(
        trackInfo.release,
        trackInfo.recording.id,
      );
      const insertedTrackId = insertTrack(tx, {
        youtube_id: trackInfo.youtubeId,
        release_group_id: release_group_id,
        filePath: trackInfo.filePath,
        recording: trackInfo.recording,
        disc_number: position?.disc_number ?? null,
        track_number: position?.track_number ?? null,
      });

      // Upsert artists and capture ids to create track <-> artist relationship
      stage = "artist_upserts";
      const insertedArtistIds = trackInfo.recording["artist-credit"].map(
        (artist, i) => {
          const artistId = insertArtist(tx, artist);
          return { artistId, pos: i + 1, joinphrase: artist.joinphrase };
        },
      );

      // Insert track_artist join table
      stage = "track_artist_insert";
      insertTrackArtist(tx, insertedTrackId, insertedArtistIds);

      return { trackId: insertedTrackId, releaseGroupId: release_group_id };
    });
  } catch (error) {
    await logIngestFailure("database_transaction_failed", error, {
      ...context,
      youtubeId: trackInfo.youtubeId,
      // Set when another job stored the same video or recording first. The caller
      // then completes the job as a duplicate.
      conflict: trackUniqueConflict(error),
      trackTitle: trackInfo.recording.title,
      stage,
      recordingFirstReleaseDate: describeDateValue(
        trackInfo.recording["first-release-date"],
      ),
      releaseDate: describeDateValue(trackInfo.release.date),
    });
    throw error;
  }

  // Written to the jsonl file too, so a wrong track can be traced to its
  // MusicBrainz ids and saved response.
  await logIngestInfo("database_transaction_committed", {
    ...context,
    youtubeId: trackInfo.youtubeId,
    trackId: committed.trackId,
    releaseGroupId: committed.releaseGroupId,
    musicbrainzRecordingId: trackInfo.recording.id ?? null,
    musicbrainzReleaseGroupId: trackInfo.release["release-group"].id ?? null,
    trackTitle: trackInfo.recording.title,
    releaseTitle: trackInfo.release["release-group"].title,
    releaseDate: describeDateValue(trackInfo.release.date),
    artistCount: trackInfo.recording["artist-credit"].length,
  });
}
