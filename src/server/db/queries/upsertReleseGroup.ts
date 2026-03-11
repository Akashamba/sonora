import type { Transaction } from "~/types/definitions/database";
import { release_groups } from "../schema";

export async function upsertReleaseGroup(tx: Transaction, release: any) {
  const [insertedReleaseGroup] = await tx
    .insert(release_groups)
    .values({
      musicbrainz_release_group_id: release["release-group"].id,
      musicbrainz_primary_type: release["release-group"]["primary-type"],
      title: release["release-group"].title,
      cover_art_url: "",
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
