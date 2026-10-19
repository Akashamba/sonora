import { eq } from "drizzle-orm";
import { db } from "..";
import { tracks } from "../schema";

// Tracks already stored under this YouTube id.
export async function queryTrackByYoutubeId(youtubeId: string) {
  return await db
    .select({ id: tracks.id })
    .from(tracks)
    .where(eq(tracks.youtube_id, youtubeId));
}
