import { sql } from "drizzle-orm";
import { db } from "..";
import { queue, tracks } from "../schema";

const MIN = 25;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Refill-then-pop, run inside the caller's transaction. Split out so a route that
// already holds a transaction (play-from) can reuse it instead of nesting one.
export const refillAndPopNextTrack = (tx: Tx) => {
  // Refill before popping. A pop from an empty queue would find nothing, and the
  // refill has to run first for the request to get a track.
  const queueInfo = tx
    .select({
      count: sql<number>`count(*)`,
      maxPosition: sql<number>`max(position)`,
    })
    .from(queue)
    .get();

  if (queueInfo?.count! < MIN) {
    const rows = tx
      .select({ id: tracks.id })
      .from(tracks)
      .orderBy(sql`RANDOM()`)
      .limit(20)
      .all();

    // An empty library has nothing to refill with. An empty values() list throws.
    if (rows.length > 0) {
      tx.insert(queue)
        .values(
          rows.map((r, i) => ({
            track_id: r.id,
            position: queueInfo?.maxPosition! + 1 + i,
          })),
        )
        .run();

      console.log("queue refilled");
    }
  }

  // consume one item
  const nextTrack = tx
    .delete(queue)
    .orderBy(queue.position)
    .limit(1)
    .returning({ track_id: queue.track_id, position: queue.position })
    .get();

  return nextTrack;
};

export const fetchNextTrackWithRefill = () => {
  return db.transaction((tx) => refillAndPopNextTrack(tx));
};
