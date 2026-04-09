import { eq, or } from "drizzle-orm";
import { db } from "..";
import { tracks } from "../schema";

export async function queryMatches(
  youtubeId: string,
  musicbrainzRecordingId: string,
) {
  return await db
    .select()
    .from(tracks)
    .where(
      or(
        eq(tracks.youtube_id, youtubeId),
        eq(tracks.musicbrainz_recording_id, musicbrainzRecordingId),
      ),
    );
}
