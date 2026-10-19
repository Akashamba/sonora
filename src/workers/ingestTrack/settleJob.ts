import { eq } from "drizzle-orm";
import { db } from "~/server/db";
import { jobs } from "~/server/db/schema";
import type { IngestProgress } from "~/services/ingestTrack";
import { logIngestFailure, logIngestInfo } from "~/utils/ingestLogger";

// Runs one claimed job and writes its final status. Each status write is timed
// and the job record says whether this job saved a track, so a track that was
// saved but whose job ends up failed can be found in the log.
export async function settleJob(
  job: { id: string; url: string },
  attempt: (progress: IngestProgress) => Promise<void>,
) {
  const progress: IngestProgress = {};
  let ingestCompleted = false;
  let writeStartedAt = performance.now();
  try {
    await attempt(progress);
    ingestCompleted = true;
    writeStartedAt = performance.now();
    db.update(jobs)
      .set({ status: "completed", updated_at: new Date() })
      .where(eq(jobs.id, job.id))
      .run();
    await logIngestInfo("job_completed", {
      jobId: job.id,
      finalStatus: "completed",
      trackCommitted: progress.trackCommitted === true,
      durationMs: Math.round(performance.now() - writeStartedAt),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const trackCommitted = progress.trackCommitted === true;
    if (ingestCompleted) {
      await logIngestFailure("job_completion_status_update_failed", error, {
        jobId: job.id,
        stage: "job_status_update",
        attemptedStatus: "completed",
        finalStatus: null,
        trackCommitted,
        durationMs: Math.round(performance.now() - writeStartedAt),
      });
    }
    writeStartedAt = performance.now();
    try {
      db.update(jobs)
        .set({ status: "failed", error: message, updated_at: new Date() })
        .where(eq(jobs.id, job.id))
        .run();
      await logIngestInfo("job_marked_failed", {
        jobId: job.id,
        finalStatus: "failed",
        trackCommitted,
        durationMs: Math.round(performance.now() - writeStartedAt),
        ingestError: message,
      });
    } catch (statusError) {
      // The row keeps the last status that was written, so finalStatus is null.
      await logIngestFailure("job_failure_status_update_failed", statusError, {
        jobId: job.id,
        stage: "job_status_update",
        attemptedStatus: "failed",
        finalStatus: null,
        trackCommitted,
        durationMs: Math.round(performance.now() - writeStartedAt),
        ingestError: message,
      });
    }
  }
}
