import { ingestTrack } from "~/services/ingestTrack";
import { claimJobs } from "./claimJobs";
import { db } from "~/server/db";
import { eq } from "drizzle-orm";
import { jobs } from "~/server/db/schema";
import { logIngestFailure, logIngestSuccess } from "~/utils/ingestLogger";

while (true) {
  let claimedJobs: { id: string; url: string }[];
  try {
    claimedJobs = await claimJobs(2);
  } catch (error) {
    await logIngestFailure("job_claim_failed", error, {
      stage: "job_claim",
    });
    await Bun.sleep(1000);
    continue;
  }

  if (claimedJobs.length === 0) {
    await Bun.sleep(1000);
    continue;
  }

  logIngestSuccess("jobs_claimed", {
    jobCount: claimedJobs.length,
    jobIds: claimedJobs.map((job) => job.id),
  });

  await Promise.all(
    claimedJobs.map(async (j) => {
      let ingestCompleted = false;
      try {
        await ingestTrack(j.url, j.id);
        ingestCompleted = true;
        db.update(jobs)
          .set({ status: "completed", updated_at: new Date() })
          .where(eq(jobs.id, j.id))
          .run();
        logIngestSuccess("job_completed", { jobId: j.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ingestCompleted) {
          await logIngestFailure("job_completion_status_update_failed", error, {
            jobId: j.id,
            stage: "job_status_update",
          });
        }
        try {
          db.update(jobs)
            .set({ status: "failed", error: message, updated_at: new Date() })
            .where(eq(jobs.id, j.id))
            .run();
          logIngestSuccess("job_marked_failed", { jobId: j.id });
        } catch (statusError) {
          await logIngestFailure(
            "job_failure_status_update_failed",
            statusError,
            {
              jobId: j.id,
              stage: "job_status_update",
              ingestError: message,
            },
          );
        }
      }
    }),
  );
}
