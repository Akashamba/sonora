import { ingestTrack } from "~/services/ingestTrack";
import { claimJobs } from "./claimJobs";
import { logIngestFailure, logIngestInfo } from "~/utils/ingestLogger";
import { logWorkerLifecycle } from "./lifecycle";
import { settleJob } from "./settleJob";

await logWorkerLifecycle();

while (true) {
  let claimedJobs: {
    id: string;
    url: string;
    claimCount: number;
    queuedForMs: number;
  }[];
  const claimStartedAt = performance.now();
  try {
    claimedJobs = await claimJobs(2);
  } catch (error) {
    await logIngestFailure("job_claim_failed", error, {
      stage: "job_claim",
      durationMs: Math.round(performance.now() - claimStartedAt),
    });
    await Bun.sleep(1000);
    continue;
  }
  const claimDurationMs = Math.round(performance.now() - claimStartedAt);

  if (claimedJobs.length === 0) {
    await Bun.sleep(1000);
    continue;
  }

  await logIngestInfo("jobs_claimed", {
    jobCount: claimedJobs.length,
    jobIds: claimedJobs.map((job) => job.id),
    claims: claimedJobs.map((job) => ({
      jobId: job.id,
      claimCount: job.claimCount,
      queuedForMs: job.queuedForMs,
    })),
    durationMs: claimDurationMs,
  });

  await Promise.all(
    claimedJobs.map((j) =>
      settleJob(j, (progress) =>
        ingestTrack(j.url, j.id, progress, { queuedForMs: j.queuedForMs }),
      ),
    ),
  );
}
