import { inArray } from "drizzle-orm";
import { db } from "..";
import { queue, tracks } from "../schema";

export class UnknownTracksError extends Error {
  constructor(readonly unknownIds: string[]) {
    super(`unknown track ids: ${unknownIds.join(", ")}`);
  }
}

// Fisher-Yates, so every order of the input is equally likely.
function shuffled<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// Puts the tracks at the top of the queue, in the given order (or shuffled), so
// the first one plays next. Positions go just below the current minimum, the
// same way the refill appends above the maximum. Returns the first track id
// that will play, or undefined when there is nothing to insert.
export function insertTracksAtQueueTop(
  trackIds: string[],
  options: { shuffle?: boolean } = {},
): string | undefined {
  const ordered = options.shuffle ? shuffled(trackIds) : trackIds;

  return db.transaction((tx) => {
    // An empty queue has no minimum; start at 0 so the new rows go negative.
    // Read even for an empty input, so a broken queue table still surfaces as a
    // route DB error.
    const queueTop =
      tx
        .select({ position: queue.position })
        .from(queue)
        .orderBy(queue.position)
        .limit(1)
        .get()?.position ?? 0;
    if (ordered.length === 0) return undefined;

    // Unknown ids would fail on the foreign key anyway; checking first gives the
    // caller a list of them instead of a generic write error.
    const unique = [...new Set(ordered)];
    const known = new Set(
      tx
        .select({ id: tracks.id })
        .from(tracks)
        .where(inArray(tracks.id, unique))
        .all()
        .map((row) => row.id),
    );
    const unknownIds = unique.filter((id) => !known.has(id));
    if (unknownIds.length > 0) throw new UnknownTracksError(unknownIds);

    tx.insert(queue)
      .values(
        ordered.map((trackId, i) => ({
          track_id: trackId,
          position: queueTop - ordered.length + i,
        })),
      )
      .run();

    return ordered[0];
  });
}
