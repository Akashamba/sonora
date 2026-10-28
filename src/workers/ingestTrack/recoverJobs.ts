import { and, eq, inArray } from "drizzle-orm";
import { db } from "~/server/db";
import { jobs } from "~/server/db/schema";
import { logIngestInfo } from "~/utils/ingestLogger";

// A job claimed this many times without finishing is treated as poison (it likely
// crashes the worker each time), so it is failed instead of queued again.
export const MAX_CLAIMS_BEFORE_FAILING = 3;

// Puts `running` jobs back in the queue. `ids` limits it to specific jobs (used at
// shutdown, for jobs this process claimed); null means every running job (used at
// startup, when the worker that claimed them has exited). claim_count is kept so
// retries stay visible.
export function releaseRunningJobs(ids: string[] | null) {
  return db.transaction(
    (tx) => {
      const running = tx
        .select({ id: jobs.id, claimCount: jobs.claim_count })
        .from(jobs)
        .where(
          and(
            eq(jobs.status, "running"),
            ids === null ? undefined : inArray(jobs.id, ids),
          ),
        )
        .all();
      if (running.length === 0) return { requeued: [], failed: [] };

      const requeued = running
        .filter((j) => j.claimCount < MAX_CLAIMS_BEFORE_FAILING)
        .map((j) => j.id);
      const failed = running
        .filter((j) => j.claimCount >= MAX_CLAIMS_BEFORE_FAILING)
        .map((j) => j.id);
      const updatedAt = new Date();

      if (requeued.length > 0) {
        tx.update(jobs)
          .set({ status: "queued", updated_at: updatedAt })
          .where(and(eq(jobs.status, "running"), inArray(jobs.id, requeued)))
          .run();
      }
      if (failed.length > 0) {
        tx.update(jobs)
          .set({
            status: "failed",
            error: `claimed ${MAX_CLAIMS_BEFORE_FAILING} times without finishing, giving up`,
            updated_at: updatedAt,
          })
          .where(and(eq(jobs.status, "running"), inArray(jobs.id, failed)))
          .run();
      }
      return { requeued, failed };
    },
    { behavior: "immediate" },
  );
}

// Startup and shutdown both call this. Each logs what it moved so a stranded job
// can be traced in the ingest log.
export async function requeueAndLog(
  ids: string[] | null,
  stage: "startup" | "shutdown",
) {
  const { requeued, failed } = releaseRunningJobs(ids);
  if (requeued.length > 0) {
    await logIngestInfo(`jobs_requeued_at_${stage}`, {
      jobCount: requeued.length,
      jobIds: requeued,
    });
  }
  if (failed.length > 0) {
    await logIngestInfo(`jobs_failed_claim_limit_at_${stage}`, {
      jobCount: failed.length,
      jobIds: failed,
      maxClaims: MAX_CLAIMS_BEFORE_FAILING,
    });
  }
  return { requeued, failed };
}
