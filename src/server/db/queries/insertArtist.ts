import type { Transaction } from "~/types/definitions/database";
import { artists } from "../schema";

export interface ArtistType {
  artist: { id: string };
  name: string;
  joinphrase?: string;
}

export async function insertArtist(tx: Transaction, artist: ArtistType) {
  const [insertedArtist] = await tx
    .insert(artists)
    .values({
      musicbrainz_id: artist.artist.id,
      name: artist.name,
    })
    .onConflictDoUpdate({
      target: artists.musicbrainz_id,
      set: { name: artist.name },
    })
    .returning();

  if (!insertedArtist) {
    throw new Error(`insertedArtist resolved to undefined after upsert`);
  }

  return insertedArtist.id;
}
