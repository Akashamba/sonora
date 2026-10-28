import type { ReleaseGroup } from "../definitions/music";
import type { Simplify } from "../utils";
import type { TrackResponse } from "./Track";

export type ReleaseGroupResponse = Simplify<
  Pick<
    ReleaseGroup,
    "id" | "title" | "cover_art_url" | "first_release_date"
  > & {
    primary_type: ReleaseGroup["musicbrainz_primary_type"];
    tracks: Simplify<
      Omit<TrackResponse, "release_group"> & {
        // Null when the track has no MusicBrainz track listing yet.
        track_number: number | null;
        disc_number: number | null;
      }
    >[];
  }
>;
