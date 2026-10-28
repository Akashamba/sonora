export const DEFAULT_SHUTDOWN_GRACE_MS = 20_000;

// WORKER_SHUTDOWN_GRACE_MS sets how long a stop waits for running jobs to finish.
export function readShutdownGraceMs(
  env: Record<string, string | undefined> = process.env,
) {
  const raw = env.WORKER_SHUTDOWN_GRACE_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_SHUTDOWN_GRACE_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_SHUTDOWN_GRACE_MS;
}

// Ids of jobs this process has claimed and not yet settled. Only these are handed
// back at shutdown, so another worker's running jobs are never touched.
export function createOwnedJobs() {
  const ids = new Set<string>();
  return {
    add: (jobIds: string[]) => {
      for (const id of jobIds) ids.add(id);
    },
    delete: (id: string) => {
      ids.delete(id);
    },
    snapshot: () => [...ids],
  };
}

// Waits up to graceMs for the pool to drain. Whatever this process still owns after
// that is handed back through `requeue`. The caller exits afterwards.
export async function drainPoolWithGrace({
  pool,
  graceMs,
  owned,
  requeue,
}: {
  pool: Promise<void>;
  graceMs: number;
  owned: ReturnType<typeof createOwnedJobs>;
  requeue: (jobIds: string[]) => Promise<unknown>;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), graceMs);
  });
  const outcome = await Promise.race([
    pool.then(
      () => "drained" as const,
      () => "drained" as const,
    ),
    expired,
  ]);
  clearTimeout(timer);

  const stillRunning = owned.snapshot();
  if (stillRunning.length > 0) await requeue(stillRunning);
  return { outcome, stillRunning };
}

export type StopState = { requested: boolean; pool: Promise<void> | undefined };

// Stops claiming, then waits for the grace period. Jobs still running after that are
// requeued, and their commands are killed so they do not outlive the worker. Only the
// first stop signal reaches this; a second one exits without waiting.
export async function stopWorker({
  state,
  graceMs,
  owned,
  requeue,
  killRunning,
}: {
  state: StopState;
  graceMs: number;
  owned: ReturnType<typeof createOwnedJobs>;
  requeue: (jobIds: string[]) => Promise<unknown>;
  killRunning: () => void;
}) {
  state.requested = true;
  // The pool is set right after the worker starts, before its first claim, so a
  // missing pool means nothing is claimed yet.
  if (!state.pool) return;
  await drainPoolWithGrace({ pool: state.pool, graceMs, owned, requeue });
  killRunning();
}
