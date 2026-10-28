export type ClaimedJob = {
  id: string;
  url: string;
  claimCount: number;
  queuedForMs: number;
};

type ClaimDeps = {
  claimJobs: (count: number) => Promise<ClaimedJob[]>;
  // Called as soon as jobs are marked running, so shutdown knows which ones are ours.
  onClaimed?: (jobs: ClaimedJob[]) => void;
  logInfo: (event: string, fields: Record<string, unknown>) => Promise<void>;
  logFailure: (
    event: string,
    error: unknown,
    fields: Record<string, unknown>,
  ) => Promise<void>;
};

// A log write that fails must not lose jobs that were already marked running.
async function bestEffort(write: () => Promise<void>) {
  try {
    await write();
  } catch (error) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        event: "ingest_log_write_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export function createClaimForPool(deps: ClaimDeps) {
  // Returns [] on failure, so the pool waits and tries again. Once claimJobs has
  // returned, the jobs are running and must be handed back, whatever logging does.
  return async (count: number): Promise<ClaimedJob[]> => {
    const claimStartedAt = performance.now();
    let claimedJobs: ClaimedJob[];
    try {
      claimedJobs = await deps.claimJobs(count);
    } catch (error) {
      await bestEffort(() =>
        deps.logFailure("job_claim_failed", error, {
          stage: "job_claim",
          durationMs: Math.round(performance.now() - claimStartedAt),
        }),
      );
      return [];
    }
    const claimDurationMs = Math.round(performance.now() - claimStartedAt);
    deps.onClaimed?.(claimedJobs);

    if (claimedJobs.length > 0) {
      await bestEffort(() =>
        deps.logInfo("jobs_claimed", {
          jobCount: claimedJobs.length,
          jobIds: claimedJobs.map((job) => job.id),
          claims: claimedJobs.map((job) => ({
            jobId: job.id,
            claimCount: job.claimCount,
            queuedForMs: job.queuedForMs,
          })),
          durationMs: claimDurationMs,
        }),
      );
    }
    return claimedJobs;
  };
}
