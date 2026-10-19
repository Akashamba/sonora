import { eq, inArray, sql } from "drizzle-orm";
import { db } from "~/server/db";
import { jobs } from "~/server/db/schema";

// Claims up to `count` queued jobs. Each claimed job gets updated_at set to the
// claim time and its claim_count incremented. queuedForMs is the wait between
// the job being created and this claim.
export const claimJobs = async (count: number) => {
  if (count <= 0) return [];

  return db.transaction(
    (tx) => {
      const claimedJobs = tx
        .select({
          id: jobs.id,
          url: jobs.url,
          createdAt: jobs.created_at,
          claimCount: jobs.claim_count,
        })
        .from(jobs)
        .where(eq(jobs.status, "queued"))
        .orderBy(jobs.created_at)
        .limit(count)
        .all();

      if (claimedJobs.length === 0) return [];

      const claimedAt = new Date();
      tx.update(jobs)
        .set({
          status: "running",
          updated_at: claimedAt,
          claim_count: sql`${jobs.claim_count} + 1`,
        })
        .where(
          inArray(
            jobs.id,
            claimedJobs.map((j) => j.id),
          ),
        )
        .run();

      return claimedJobs.map((j) => ({
        id: j.id,
        url: j.url,
        claimCount: j.claimCount + 1,
        queuedForMs: claimedAt.getTime() - j.createdAt.getTime(),
      }));
    },
    { behavior: "immediate" },
  );
};
