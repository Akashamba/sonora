import { describe, expect, test } from "bun:test";
import { runIngestPool } from "../src/workers/ingestTrack/pool";

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls until the condition holds, so assertions that something happened do not
// depend on how fast a loaded machine runs the pool. Negative checks still use tick().
async function until(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await tick(5);
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

// Hands out queued jobs like claimJobs does: at most `count`, oldest first.
function fakeQueue<T>(items: T[]) {
  const claimCounts: number[] = [];
  return {
    claimCounts,
    claim: async (count: number) => {
      claimCounts.push(count);
      return items.splice(0, count);
    },
  };
}

describe("runIngestPool", () => {
  test("never runs more jobs than the target and refills slots as jobs finish", async () => {
    let running = 0;
    let maxRunning = 0;
    let finished = 0;
    const queue = fakeQueue(Array.from({ length: 12 }, (_, id) => ({ id })));

    await runIngestPool({
      getTarget: async () => 3,
      checkIntervalMs: 1,
      idleMs: 1,
      claim: queue.claim,
      run: async (job) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await tick(2 + (job.id % 4) * 3);
        running--;
        finished++;
      },
      isStopped: () => finished === 12,
    });

    expect(maxRunning).toBe(3);
    expect(finished).toBe(12);
    expect(queue.claimCounts.every((count) => count >= 1 && count <= 3)).toBe(
      true,
    );
  });

  test("claims only as many jobs as there are free slots", async () => {
    const gates = [0, 1, 2, 3].map(() => gate());
    const started: number[] = [];
    const queue = fakeQueue([0, 1, 2, 3].map((id) => ({ id })));
    let stopped = false;

    const pool = runIngestPool({
      getTarget: async () => 3,
      checkIntervalMs: 1000,
      idleMs: 1,
      claim: queue.claim,
      run: async (job) => {
        started.push(job.id);
        await gates[job.id]!.promise;
      },
      isStopped: () => stopped,
    });

    await tick();
    expect(started).toEqual([0, 1, 2]);
    expect(queue.claimCounts).toEqual([3]);

    gates[1]!.open();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(queue.claimCounts).toEqual([3, 1]);

    stopped = true;
    gates.forEach((g) => g.open());
    await pool;
  });

  test("a lower target stops new claims until enough jobs finish", async () => {
    let target = 3;
    const gates = [0, 1, 2, 3].map(() => gate());
    const started: number[] = [];
    const queue = fakeQueue([0, 1, 2, 3].map((id) => ({ id })));
    let stopped = false;

    const pool = runIngestPool({
      getTarget: async () => target,
      checkIntervalMs: 1,
      idleMs: 1,
      claim: queue.claim,
      run: async (job) => {
        started.push(job.id);
        await gates[job.id]!.promise;
      },
      isStopped: () => stopped,
    });

    await until(() => started.length === 3);
    expect(started).toEqual([0, 1, 2]);

    target = 1;
    // The pool re-reads the target at most once per checkIntervalMs, so let it see
    // the new value before a slot frees. Otherwise it can still claim with the old one.
    await tick();
    gates[0]!.open();
    await tick();
    gates[1]!.open();
    await tick();
    // Two jobs are still running, one is above the new target, so nothing new is claimed.
    expect(queue.claimCounts).toEqual([3]);

    gates[2]!.open();
    await until(() => started.length === 4);
    expect(started).toEqual([0, 1, 2, 3]);
    expect(queue.claimCounts).toEqual([3, 1]);

    stopped = true;
    gates[3]!.open();
    await pool;
  });

  test("a rejected getTarget keeps the previous target", async () => {
    let calls = 0;
    const started: number[] = [];
    const queue = fakeQueue([0, 1, 2].map((id) => ({ id })));
    let stopped = false;
    const gates = [0, 1, 2].map(() => gate());

    const pool = runIngestPool({
      getTarget: async () => {
        calls++;
        if (calls > 1) throw new Error("probe failed");
        return 2;
      },
      checkIntervalMs: 1,
      idleMs: 1,
      claim: queue.claim,
      run: async (job) => {
        started.push(job.id);
        await gates[job.id]!.promise;
      },
      isStopped: () => stopped,
    });

    await tick();
    expect(started).toEqual([0, 1]);
    stopped = true;
    gates.forEach((g) => g.open());
    await pool;
  });

  test("a throwing claim waits and retries instead of ending the loop", async () => {
    let claimCalls = 0;
    const ran: number[] = [];
    let stopped = false;

    await runIngestPool({
      getTarget: async () => 2,
      checkIntervalMs: 1,
      idleMs: 1,
      claim: async (count) => {
        claimCalls++;
        if (claimCalls <= 2) throw new Error("database is locked");
        return [{ id: 0 }, { id: 1 }]
          .slice(0, count)
          .filter((job) => !ran.includes(job.id));
      },
      run: async (job) => {
        ran.push(job.id);
        if (ran.length === 2) stopped = true;
      },
      isStopped: () => stopped,
    });

    expect(claimCalls).toBeGreaterThan(2);
    expect(ran.sort()).toEqual([0, 1]);
  });

  test("every claimed job runs, even when claim returns more than asked", async () => {
    const ran: number[] = [];
    let claimed = false;
    let stopped = false;

    await runIngestPool({
      getTarget: async () => 1,
      checkIntervalMs: 1000,
      idleMs: 1,
      claim: async () => {
        if (claimed) return [];
        claimed = true;
        return [0, 1, 2].map((id) => ({ id }));
      },
      run: async (job) => {
        ran.push(job.id);
        if (ran.length === 3) stopped = true;
      },
      isStopped: () => stopped,
    });

    expect(ran.sort()).toEqual([0, 1, 2]);
  });

  test("a synchronous throw from run does not strand the other claimed jobs", async () => {
    const ran: number[] = [];
    let claimed = false;
    let stopped = false;

    await runIngestPool({
      getTarget: async () => 3,
      checkIntervalMs: 1000,
      idleMs: 1,
      claim: async () => {
        if (claimed) return [];
        claimed = true;
        return [0, 1, 2].map((id) => ({ id }));
      },
      run: (job: { id: number }) => {
        if (job.id === 0) throw new Error("boom");
        ran.push(job.id);
        if (ran.length === 2) stopped = true;
        return Promise.resolve();
      },
      isStopped: () => stopped,
    });

    expect(ran.sort()).toEqual([1, 2]);
  });
});
