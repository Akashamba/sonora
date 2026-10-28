import { eq, lt } from "drizzle-orm";
import { db } from "..";
import { queue } from "../schema";
import { refillAndPopNextTrack } from "./fetchNextTrackWithRefill";

// Up Next tap-to-play: drops every queue row above `position`, then pops the row
// at `position` the same way /tracks/next does. Returns null, with nothing written,
// when there is no row at that position or its track is gone.
export function playFromQueuePosition(
  position: number,
): { track_id: string } | null {
  return db.transaction((tx) => {
    const target = tx
      .select({ track_id: queue.track_id })
      .from(queue)
      .where(eq(queue.position, position))
      .get();
    if (!target?.track_id) return null;

    tx.delete(queue).where(lt(queue.position, position)).run();

    // The target is now the lowest row, so the shared pop takes it. The refill can
    // only append above the maximum, so it cannot pre-empt the target.
    const next = refillAndPopNextTrack(tx);
    if (!next?.track_id) return null;
    return { track_id: next.track_id };
  });
}
