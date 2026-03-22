import type { ReleaseGroup } from "../definitions/music";
import type { Simplify } from "../utils";
import type { TrackResponse } from "./Track";

export type ReleaseGroupResponse = Simplify<
  Pick<
    ReleaseGroup,
    "id" | "title" | "cover_art_url" | "first_release_date"
  > & {
    primary_type: ReleaseGroup["musicbrainz_primary_type"];
    tracks: Simplify<Omit<TrackResponse, "release_group">>[];
  }
>;
