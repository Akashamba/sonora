import type { Transaction } from "~/types/definitions/database";
import { release_groups } from "../schema";

export async function upsertReleaseGroup(
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
  const [insertedReleaseGroup] = await tx
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
      },
    })
    .returning({ id: release_groups.id });

  if (!insertedReleaseGroup?.id) {
    throw new Error("release_group_id resolved to undefined after upsert");
  }

  return insertedReleaseGroup.id;
}
