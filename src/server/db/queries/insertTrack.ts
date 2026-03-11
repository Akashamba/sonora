import type { Transaction } from "~/types/definitions/database";
import { tracks } from "../schema";

interface TrackType {
  release_group_id: string;
  filePath: string;
  recording: {
    id: string;
    title: string;
    "first-release-date": string;
    length: number;
  };
  youtube_id: string;
}

export async function insertTrack(tx: Transaction, track: TrackType) {
  const [insertedTrack] = await tx
    .insert(tracks)
    .values({
      youtube_id: track.youtube_id,
      musicbrainz_recording_id: track.recording.id,
      release_group_id: track.release_group_id,
      title: track.recording.title,
      first_release_date: new Date(track.recording["first-release-date"]),
      length: track.recording.length,
      file_path: track.filePath,
    })
    .returning({ id: tracks.id });

  if (!insertedTrack) {
    throw new Error(
      "Insert returned no rows — possible conflict with no .returning() fallback",
    );
  }

  return insertedTrack.id;
}
