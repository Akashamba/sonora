import { desc, sql } from "drizzle-orm";
import { db } from "..";
import { queue, tracks } from "../schema";

const MIN = 25;

export const fetchNextTrackWithRefill = () => {
  return db.transaction((tx) => {
    // consume one item
    const nextTrack = db
      .delete(queue)
      .orderBy(queue.position)
      .limit(1)
      .returning({ track_id: queue.track_id, position: queue.position })
      .get();

    const queueInfo = tx
      .select({
        count: sql<number>`count(*)`,
        maxPosition: sql<number>`max(position)`,
      })
      .from(queue)
      .get();

    // Refill Queue
    if (queueInfo?.count! < MIN) {
      const rows = db
        .select({ id: tracks.id })
        .from(tracks)
        .orderBy(sql`RANDOM()`)
        .limit(20)
        .all();

      db.insert(queue)
        .values(
          rows.map((r, i) => ({
            track_id: r.id,
            position: queueInfo?.maxPosition! + 1 + i,
          })),
        )
        .run();

      console.log("queue refilled");
    }

    return nextTrack;
  });
};
