import { eq, inArray } from "drizzle-orm";
import { db } from "~/server/db";
import { jobs } from "~/server/db/schema";

export const claimJobs = async (count: number) => {
  if (count <= 0) return [];

  return db.transaction(
    (tx) => {
      const claimedJobs = tx
        .select({ id: jobs.id, url: jobs.url })
        .from(jobs)
        .where(eq(jobs.status, "queued"))
        .orderBy(jobs.created_at)
        .limit(count)
        .all();

      if (claimedJobs.length === 0) return [];

      tx.update(jobs)
        .set({ status: "running" })
        .where(
          inArray(
            jobs.id,
            claimedJobs.map((j) => j.id),
          ),
        )
        .run();

      return claimedJobs.map((j) => ({ id: j.id, url: j.url }));
    },
    { behavior: "immediate" },
  );
};
