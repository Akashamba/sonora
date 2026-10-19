import { eq } from "drizzle-orm";
import { db } from "..";
import { tracks } from "../schema";

// Tracks that already own this file path. Used for logging only.
export async function queryTracksByFilePath(filePath: string) {
  return await db
    .select({ id: tracks.id, youtubeId: tracks.youtube_id })
    .from(tracks)
    .where(eq(tracks.file_path, filePath));
}
