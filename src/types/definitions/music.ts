import type { InferSelectModel } from "drizzle-orm";
import {
  artists,
  release_groups,
  track_artists,
  tracks,
} from "~/server/db/schema";

export type Track = InferSelectModel<typeof tracks>;
export type ReleaseGroup = InferSelectModel<typeof release_groups>;
export type Artist = InferSelectModel<typeof artists>;
export type TrackArtist = InferSelectModel<typeof track_artists>;
