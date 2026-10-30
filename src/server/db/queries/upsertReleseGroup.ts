import { sql } from "drizzle-orm";
import type { Transaction } from "~/types/definitions/database";
import { release_groups } from "../schema";

// Synchronous on purpose: bun:sqlite transactions commit when the callback returns,
// so every write inside one must run before it returns.
export function upsertReleaseGroup(
  tx: Transaction,
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
  },
) {
  const insertedReleaseGroup = tx
    .insert(release_groups)
    .values({
      musicbrainz_release_group_id: release["release-group"].id,
      musicbrainz_primary_type: release["release-group"]["primary-type"],
      title: release["release-group"].title,
      cover_art_url: release["release-group"].cover_art_url,
      cover_art_url_thumbnail_large:
        release["release-group"].cover_art_url_thumbnail_large,
      cover_art_url_thumbnail_small:
        release["release-group"].cover_art_url_thumbnail_small,
      first_release_date: new Date(release.date),
    })
    .onConflictDoUpdate({
      target: release_groups.musicbrainz_release_group_id,
      set: {
        musicbrainz_release_group_id: release["release-group"].id,
        // The track that created the row may have failed its cover lookup. A later
        // track's lookup fills the gap, and never replaces a stored cover.
        cover_art_url: sql`coalesce(${release_groups.cover_art_url}, excluded.cover_art_url)`,
        cover_art_url_thumbnail_large: sql`coalesce(${release_groups.cover_art_url_thumbnail_large}, excluded.cover_art_url_thumbnail_large)`,
        cover_art_url_thumbnail_small: sql`coalesce(${release_groups.cover_art_url_thumbnail_small}, excluded.cover_art_url_thumbnail_small)`,
      },
    })
    .returning({ id: release_groups.id })
    .get();

  if (!insertedReleaseGroup?.id) {
    throw new Error("release_group_id resolved to undefined after upsert");
  }

  return insertedReleaseGroup.id;
}
