import { db } from "..";
import { insertArtist, type ArtistType } from "~/db/queries/insertArtist";
import { insertTrack } from "~/db/queries/insertTrack";
import {
  insertTrackArtist,
  type InsertedAristType,
} from "~/db/queries/insertTrackArtist";
import { upsertReleaseGroup } from "~/db/queries/upsertReleseGroup";

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

export async function addNewTrack(trackInfo: TrackInfoType) {
  await db.transaction(async (tx) => {
    // Upsert release group
    const release_group_id = await upsertReleaseGroup(tx, trackInfo.release);

    // Insert track
    const insertedTrackId = await insertTrack(tx, {
      youtube_id: trackInfo.youtubeId,
      release_group_id: release_group_id,
      filePath: trackInfo.filePath,
      recording: trackInfo.recording,
    });

    // Upsert artists and capture ids to create track <-> artist relationship
    const insertedArtistIds = await Promise.all(
      trackInfo.recording["artist-credit"].map(async (artist, i) => {
        const artistId = await insertArtist(tx, artist);
        return { artistId, pos: i + 1, joinphrase: artist.joinphrase };
      }),
    );

    // Insert track_artist join table
    await insertTrackArtist(tx, insertedTrackId, insertedArtistIds);
  });
}
