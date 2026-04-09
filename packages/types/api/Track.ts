import type { Simplify } from "drizzle-orm";
import type {
  Artist,
  ReleaseGroup,
  Track,
  TrackArtist,
} from "../definitions/music";

type TrackResponseArtist = Simplify<
  Pick<Artist, "id" | "name"> &
    Simplify<Pick<TrackArtist, "pos">> &
    Simplify<Pick<TrackArtist, "joinphrase">>
>;

type TrackResponseReleaseGroup = Simplify<
  Pick<
    ReleaseGroup,
    "id" | "title" | "cover_art_url" | "cover_art_url_thumbnail_small"
  >
>;

export type TrackResponse = Simplify<
  Pick<Track, "id" | "title" | "length"> & {
    artists: TrackResponseArtist[];
    release_group: TrackResponseReleaseGroup;
    liked: boolean;
    position: number | null;
  }
>;
