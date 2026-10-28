import { describe, expect, test } from "bun:test";
import {
  DEFAULT_JOB_MEMORY_BYTES,
  DEFAULT_MAX_CONCURRENCY,
  createConcurrencyController,
  decideConcurrency,
  readConcurrencyConfig,
  type ConcurrencyConfig,
} from "../src/workers/ingestTrack/concurrency";
import type { ResourceSnapshot } from "../src/workers/ingestTrack/resources";

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

// A healthy 4-core machine with 16 GiB total and 12 GiB available.
const healthy = (
  overrides: Partial<ResourceSnapshot> = {},
): ResourceSnapshot => ({
  takenAt: 0,
  cpuCount: 4,
  load1: 0.5,
  memTotalBytes: 16 * GIB,
  memAvailableBytes: 12 * GIB,
  cgroupLimitBytes: null,
  cgroupHeadroomBytes: null,
  psi: { cpuSome: 0, memorySome: 0, ioSome: 0 },
  ...overrides,
});

const config = (
  overrides: Partial<ConcurrencyConfig> = {},
): ConcurrencyConfig => ({
  pinned: null,
  maxConcurrency: DEFAULT_MAX_CONCURRENCY,
  jobMemoryBytes: DEFAULT_JOB_MEMORY_BYTES,
  ...overrides,
});

const decide = (
  snapshot: ResourceSnapshot,
  options: {
    inFlight?: number;
    previousTarget?: number | null;
    config?: ConcurrencyConfig;
  } = {},
) =>
  decideConcurrency(snapshot, {
    inFlight: options.inFlight ?? 0,
    previousTarget: options.previousTarget ?? null,
    config: options.config ?? config(),
  });

describe("decideConcurrency", () => {
  test("healthy machine with plenty of memory uses the hard cap", () => {
    const decision = decide(healthy(), {
      config: config({ maxConcurrency: 4 }),
    });
    expect(decision.target).toBe(4);
    expect(decision.reason).toBe("hard_cap");
  });

  test("healthy machine is capped at 8 by default, not at the core count", () => {
    const decision = decide(healthy());
    expect(decision.target).toBe(8);
    expect(decision.limits.cpu).toBe(8); // 4 cores x 2 for network-bound jobs
  });

  test("low memory drops to one job", () => {
    // 1.5 GiB free is below the 2.4 GiB reserve on a 16 GiB machine.
    const decision = decide(healthy({ memAvailableBytes: 1.5 * GIB }));
    expect(decision.target).toBe(1);
    expect(decision.reason).toBe("memory");
  });

  test("memory budget counts jobs already running as usable", () => {
    // Free memory is below the reserve, but three of our jobs already use memory.
    const decision = decide(healthy({ memAvailableBytes: 2.4 * GIB }), {
      inFlight: 3,
    });
    expect(decision.limits.memory).toBe(3);
    expect(decision.computed).toBe(3);
  });

  test("the per-job estimate is configurable", () => {
    const snapshot = healthy({ memAvailableBytes: 4 * GIB });
    // (4 GiB - 2.4 GiB reserve) = 1.6 GiB free. At 400 MiB that is 4 jobs.
    expect(decide(snapshot).limits.memory).toBe(4);
    // At 800 MiB it is 2 jobs.
    expect(
      decide(snapshot, { config: config({ jobMemoryBytes: 800 * MIB }) }).limits
        .memory,
    ).toBe(2);
  });

  test("a tight cgroup beats a large host MemAvailable", () => {
    const decision = decide(
      healthy({ cgroupLimitBytes: 2 * GIB, cgroupHeadroomBytes: 0.5 * GIB }),
    );
    // 0.5 GiB headroom is under the 1 GiB reserve (15% of the 2 GiB limit, floored at 1 GiB).
    expect(decision.limits.memory).toBe(0);
    expect(decision.target).toBe(1);
    expect(decision.reason).toBe("memory");
  });

  test("high memory PSI drops to the floor", () => {
    const decision = decide(
      healthy({ psi: { cpuSome: 0, memorySome: 15, ioSome: 0 } }),
      {
        previousTarget: 6,
      },
    );
    expect(decision.computed).toBe(1);
    expect(decision.target).toBe(1);
    expect(decision.reason).toBe("memory_psi");
  });

  test("high IO PSI drops to the floor", () => {
    const decision = decide(
      healthy({ psi: { cpuSome: 0, memorySome: 0, ioSome: 30 } }),
    );
    expect(decision.target).toBe(1);
    expect(decision.reason).toBe("io_psi");
  });

  test("CPU PSI stress limits the target to the core count", () => {
    const decision = decide(
      healthy({ psi: { cpuSome: 25, memorySome: 0, ioSome: 0 } }),
    );
    expect(decision.target).toBe(4);
    expect(decision.reason).toBe("cpu_busy");
  });

  test("severe CPU PSI drops to one job", () => {
    const decision = decide(
      healthy({ psi: { cpuSome: 60, memorySome: 0, ioSome: 0 } }),
    );
    expect(decision.target).toBe(1);
    expect(decision.reason).toBe("cpu_saturated");
  });

  test("load per core backs off: stressed at 1, saturated at 2", () => {
    expect(decide(healthy({ load1: 5 })).limits.cpu).toBe(4);
    expect(decide(healthy({ load1: 8 })).target).toBe(1);
  });

  test("many cores allow more jobs, still bounded by the cap", () => {
    const many = healthy({ cpuCount: 32 });
    expect(decide(many).target).toBe(8);
    expect(
      decide(many, { config: config({ maxConcurrency: 16 }) }).target,
    ).toBe(16);
  });

  test("INGEST_CONCURRENCY pins the value even under pressure", () => {
    const decision = decide(
      healthy({
        memAvailableBytes: 1 * GIB,
        psi: { cpuSome: 0, memorySome: 50, ioSome: 0 },
      }),
      { config: config({ pinned: 3 }), previousTarget: 1 },
    );
    expect(decision.target).toBe(3);
    expect(decision.reason).toBe("pinned");
    expect(decision.rateLimited).toBe(false);
  });

  test("INGEST_CONCURRENCY above the cap is clamped to the cap", () => {
    const decision = decide(healthy(), {
      config: config({ pinned: 20, maxConcurrency: 8 }),
    });
    expect(decision.target).toBe(8);
    expect(decision.computed).toBe(8);
    expect(decision.reason).toBe("hard_cap");
    expect(decision.limits.cap).toBe(8);
  });

  test("INGEST_MAX_CONCURRENCY raises the cap for a pinned value", () => {
    const decision = decide(healthy(), {
      config: config({ pinned: 12, maxConcurrency: 16 }),
    });
    expect(decision.target).toBe(12);
    expect(decision.reason).toBe("pinned");
  });

  test("scale-up is limited to one job per check", () => {
    const decision = decide(healthy(), { previousTarget: 2 });
    expect(decision.computed).toBe(8);
    expect(decision.target).toBe(3);
    expect(decision.rateLimited).toBe(true);
  });

  test("scale-down is immediate", () => {
    const decision = decide(healthy({ memAvailableBytes: 3 * GIB }), {
      previousTarget: 8,
    });
    expect(decision.computed).toBe(1);
    expect(decision.target).toBe(1);
    expect(decision.rateLimited).toBe(false);
  });

  test("unknown memory falls back to the old batch size of two", () => {
    const decision = decide(
      healthy({ memAvailableBytes: null, memTotalBytes: null }),
    );
    expect(decision.target).toBe(2);
    expect(decision.reason).toBe("memory_unknown");
  });

  test("missing PSI counts as no pressure", () => {
    const decision = decide(
      healthy({ psi: { cpuSome: null, memorySome: null, ioSome: null } }),
    );
    expect(decision.target).toBe(8);
  });
});

describe("readConcurrencyConfig", () => {
  test("defaults when no env is set", () => {
    expect(readConcurrencyConfig({})).toEqual({
      pinned: null,
      maxConcurrency: 8,
      jobMemoryBytes: 400 * MIB,
    });
  });

  test("reads the three overrides", () => {
    expect(
      readConcurrencyConfig({
        INGEST_CONCURRENCY: "3",
        INGEST_MAX_CONCURRENCY: "12",
        INGEST_JOB_MEMORY_MB: "600",
      }),
    ).toEqual({ pinned: 3, maxConcurrency: 12, jobMemoryBytes: 600 * MIB });
  });

  test("invalid values fall back to the defaults", () => {
    expect(
      readConcurrencyConfig({
        INGEST_CONCURRENCY: "0",
        INGEST_MAX_CONCURRENCY: "lots",
        INGEST_JOB_MEMORY_MB: "-5",
      }),
    ).toEqual({ pinned: null, maxConcurrency: 8, jobMemoryBytes: 400 * MIB });
    expect(
      readConcurrencyConfig({ INGEST_CONCURRENCY: "2.5" }).pinned,
    ).toBeNull();
  });
});

describe("createConcurrencyController", () => {
  test("reports only when the target changes, and keeps the last value on read failure", async () => {
    const changes: { previousTarget: number | null; target: number }[] = [];
    let snapshot = healthy({ memAvailableBytes: 1 * GIB });
    let fail = false;
    const getTarget = createConcurrencyController({
      config: config(),
      readSnapshot: async () => {
        if (fail) throw new Error("probe broke");
        return snapshot;
      },
      onChange: ({ previousTarget, decision }) => {
        changes.push({ previousTarget, target: decision.target });
      },
    });

    expect(await getTarget(0)).toBe(1);
    expect(await getTarget(0)).toBe(1);
    expect(changes).toEqual([{ previousTarget: null, target: 1 }]);

    snapshot = healthy();
    expect(await getTarget(1)).toBe(2); // one step up
    expect(changes.at(-1)).toEqual({ previousTarget: 1, target: 2 });

    fail = true;
    expect(await getTarget(2)).toBe(2); // read failed, keep the last target
    expect(changes.length).toBe(2);
  });

  test("a failing onChange does not keep a stale target", async () => {
    let snapshot = healthy({ memAvailableBytes: 1 * GIB });
    let logCalls = 0;
    const getTarget = createConcurrencyController({
      config: config(),
      readSnapshot: async () => snapshot,
      onChange: () => {
        logCalls++;
        throw new Error("log write failed");
      },
    });

    // The first change is logged and fails. The target still comes back.
    expect(await getTarget(0)).toBe(1);
    expect(logCalls).toBe(1);

    // Memory recovers. The next check must see 1 as the previous target and step up.
    snapshot = healthy();
    expect(await getTarget(1)).toBe(2);
    expect(logCalls).toBe(2);
  });
});
