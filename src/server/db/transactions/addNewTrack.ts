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
import { logIngestFailure, logIngestSuccess } from "~/utils/ingestLogger";

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
  context: { jobId: string },
) {
  let stage = "release_group_upsert";
  try {
    await db.transaction(async (tx) => {
      // Upsert release group
      const release_group_id = await upsertReleaseGroup(tx, trackInfo.release);

      // Insert track
      stage = "track_insert";
      const insertedTrackId = await insertTrack(tx, {
        youtube_id: trackInfo.youtubeId,
        release_group_id: release_group_id,
        filePath: trackInfo.filePath,
        recording: trackInfo.recording,
      });

      // Upsert artists and capture ids to create track <-> artist relationship
      stage = "artist_upserts";
      const insertedArtistIds = await Promise.all(
        trackInfo.recording["artist-credit"].map(async (artist, i) => {
          const artistId = await insertArtist(tx, artist);
          return { artistId, pos: i + 1, joinphrase: artist.joinphrase };
        }),
      );

      // Insert track_artist join table
      stage = "track_artist_insert";
      await insertTrackArtist(tx, insertedTrackId, insertedArtistIds);
    });
  } catch (error) {
    await logIngestFailure("database_transaction_failed", error, {
      ...context,
      youtubeId: trackInfo.youtubeId,
      trackTitle: trackInfo.recording.title,
      stage,
      recordingFirstReleaseDate: describeDateValue(
        trackInfo.recording["first-release-date"],
      ),
      releaseDate: describeDateValue(trackInfo.release.date),
    });
    throw error;
  }

  logIngestSuccess("database_transaction_committed", {
    ...context,
    youtubeId: trackInfo.youtubeId,
    trackTitle: trackInfo.recording.title,
    releaseTitle: trackInfo.release["release-group"].title,
    artistCount: trackInfo.recording["artist-credit"].length,
  });
}
