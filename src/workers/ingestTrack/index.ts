import { ingestTrack } from "~/services/ingestTrack";
import { logIngestFailure, logIngestInfo } from "~/utils/ingestLogger";
import { createClaimForPool, type ClaimedJob } from "./claimForPool";
import { claimJobs } from "./claimJobs";
import {
  createConcurrencyController,
  readConcurrencyConfig,
} from "./concurrency";
import { logWorkerLifecycle } from "./lifecycle";
import { killAllRunningCommands } from "~/utils/runCommand";
import { runIngestPool } from "./pool";
import { lowerWorkerPriority } from "./priority";
import { requeueAndLog } from "./recoverJobs";
import { readResourceSnapshot } from "./resources";
import { settleJob } from "./settleJob";
import {
  createOwnedJobs,
  readShutdownGraceMs,
  stopWorker,
  type StopState,
} from "./shutdown";

// One worker per DB, so a job still `running` at startup was claimed by a worker
// that is gone. Hand those back before claiming anything.
await requeueAndLog(null, "startup");

const owned = createOwnedJobs();
const stopState: StopState = { requested: false, pool: undefined };

await logWorkerLifecycle(process.exit, {
  stop: () =>
    stopWorker({
      state: stopState,
      graceMs: readShutdownGraceMs(),
      owned,
      requeue: (ids) => requeueAndLog(ids, "shutdown"),
      killRunning: killAllRunningCommands,
    }),
  beforeExit: killAllRunningCommands,
});
await lowerWorkerPriority();

const claimForPool = createClaimForPool({
  claimJobs,
  onClaimed: (claimed) => owned.add(claimed.map((j) => j.id)),
  logInfo: logIngestInfo,
  logFailure: logIngestFailure,
});

const getTarget = createConcurrencyController({
  config: readConcurrencyConfig(),
  readSnapshot: readResourceSnapshot,
  onChange: ({ previousTarget, decision, snapshot, inFlight }) =>
    logIngestInfo("ingest_concurrency_changed", {
      previousTarget,
      target: decision.target,
      computed: decision.computed,
      reason: decision.reason,
      rateLimited: decision.rateLimited,
      inFlight,
      limits: decision.limits,
      snapshot,
    }),
});

stopState.pool = runIngestPool<ClaimedJob>({
  getTarget,
  claim: claimForPool,
  // Stop claiming once a stop is requested. Jobs already running finish or are
  // handed back when the grace period ends.
  isStopped: () => stopState.requested,
  run: async (j) => {
    try {
      await settleJob(j, (progress) =>
        ingestTrack(j.url, j.id, progress, { queuedForMs: j.queuedForMs }),
      );
    } finally {
      owned.delete(j.id);
    }
  },
});
await stopState.pool;
