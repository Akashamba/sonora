import type { Transaction } from "~/types/definitions/database";
import { track_artists } from "../schema";

export interface InsertedAristType {
  artistId: string;
  pos: number;
  joinphrase?: string;
}

export async function insertTrackArtist(
  tx: Transaction,
  insertedTrackId: string,
  insertedArtists: InsertedAristType[],
) {
  await tx.insert(track_artists).values(
    insertedArtists.map(({ artistId, pos, joinphrase }) => ({
      track_id: insertedTrackId,
      artist_id: artistId,
      pos,
      joinphrase,
    })),
  );
}
