import { sql } from "drizzle-orm";
import { db } from "..";
import { queue, tracks } from "../schema";

const MIN = 25;

export const fetchNextTrackWithRefill = () => {
  return db.transaction((tx) => {
    // consume one item
    const nextTrack = db
      .delete(queue)
      .orderBy(queue.id)
      .limit(1)
      .returning({ track_id: queue.track_id })
      .get();

    const count = tx
      .select({ count: sql<number>`count(*)` })
      .from(queue)
      .get();

    // Refill Queue
    if (count?.count! < MIN) {
      const rows = db
        .select({ id: tracks.id })
        .from(tracks)
        .orderBy(sql`RANDOM()`)
        .limit(20)
        .all();

      db.insert(queue)
        .values(
          rows.map((r) => ({
            track_id: r.id,
          })),
        )
        .run();

      console.log("queue refilled");
    }

    return nextTrack;
  });
};
