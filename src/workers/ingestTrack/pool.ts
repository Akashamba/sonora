// Keeps up to `target` jobs in flight. Jobs are claimed only for free slots, so
// the number running never goes over the target. A slot is refilled as soon as its
// job settles. The target is re-read every `checkIntervalMs`, and a lower target
// stops new claims until enough jobs finish.
export async function runIngestPool<J>(options: {
  // Called with the number of jobs now running. Result is the target.
  getTarget: (inFlight: number) => Promise<number>;
  // Claims up to `count` jobs. Empty array when the queue is empty. Every job it
  // returns is run, so it must not hand back jobs it has not marked as taken.
  claim: (count: number) => Promise<J[]>;
  // Must not reject. Errors are handled by the caller, as settleJob does.
  run: (job: J) => Promise<void>;
  checkIntervalMs?: number;
  idleMs?: number;
  isStopped?: () => boolean;
}): Promise<void> {
  const checkIntervalMs = options.checkIntervalMs ?? 5000;
  const idleMs = options.idleMs ?? 1000;
  const isStopped = options.isStopped ?? (() => false);
  const inFlight = new Set<Promise<void>>();

  let target = 1;
  let lastCheckAt = Number.NEGATIVE_INFINITY;

  // Runs through a promise chain so a synchronous throw from `run` cannot escape
  // the loop and strand the other jobs in the batch.
  const start = (job: J) => {
    const tracked: Promise<void> = Promise.resolve()
      .then(() => options.run(job))
      .catch(() => {})
      .finally(() => {
        inFlight.delete(tracked);
      });
    inFlight.add(tracked);
  };

  // Resolves when any job settles or after `ms`, whichever is first.
  const waitForSlotOrTimeout = (ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    const settled =
      inFlight.size === 0 ? timeout : Promise.race([...inFlight, timeout]);
    return settled.finally(() => clearTimeout(timer));
  };

  while (!isStopped()) {
    if (Date.now() - lastCheckAt >= checkIntervalMs) {
      lastCheckAt = Date.now();
      try {
        target = await options.getTarget(inFlight.size);
      } catch {
        // Keep the previous target when the check fails.
      }
    }

    const free = target - inFlight.size;
    if (free <= 0) {
      await waitForSlotOrTimeout(checkIntervalMs);
      continue;
    }

    let jobs: J[];
    try {
      jobs = await options.claim(free);
    } catch {
      // The claim may already have logged the failure. Wait before retrying so a
      // broken queue does not turn into a busy loop.
      await waitForSlotOrTimeout(checkIntervalMs);
      continue;
    }
    if (jobs.length === 0) {
      await waitForSlotOrTimeout(idleMs);
      continue;
    }
    // Claimed jobs are already marked running in the queue, so all of them must
    // run. Slicing here would leave the extra ones stuck as running forever.
    for (const job of jobs) start(job);
  }

  await Promise.all(inFlight);
}
