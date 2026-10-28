import type { ResourceSnapshot } from "./resources";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

// Per-job estimate. Measured with yt-dlp + ffmpeg (bestaudio, m4a, embedded
// thumbnail) on a 3.5 minute video: summed RSS of the process tree peaked at
// 380-410 MB across runs, and the largest single process at 285-316 MB. RSS counts
// shared libraries in every process, so the sum overstates real use. We keep the
// high end as the estimate to stay on the safe side.
export const DEFAULT_JOB_MEMORY_BYTES = 400 * MIB;

// YouTube throttles or returns 403s when one IP makes many parallel downloads,
// so the adaptive value never goes above this unless INGEST_MAX_CONCURRENCY says so.
export const DEFAULT_MAX_CONCURRENCY = 8;

// Jobs spend most of their time waiting on the network, so the CPU budget allows
// more jobs than cores while the machine is healthy.
const NETWORK_JOBS_PER_CORE = 2;

// Memory kept free for other processes: whichever is larger of 1 GiB or 15% of total.
const MIN_MEMORY_RESERVE_BYTES = 1 * GIB;
const MEMORY_RESERVE_FRACTION = 0.15;

// Thresholds for the "some avg10" PSI value (percent of time stalled).
export const MEMORY_PSI_LIMIT = 10;
export const IO_PSI_LIMIT = 25;
export const CPU_PSI_STRESS = 20;
export const CPU_PSI_SEVERE = 50;

// Load average per core. Above STRESS we stop growing past the core count, and
// above SEVERE we drop to one job.
export const LOAD_PER_CORE_STRESS = 1;
export const LOAD_PER_CORE_SEVERE = 2;

// Used when no memory figure can be read, which matches the old fixed batch of two.
const UNKNOWN_MEMORY_FALLBACK = 2;

export type ConcurrencyConfig = {
  // INGEST_CONCURRENCY. Fixes the target, but never above maxConcurrency.
  pinned: number | null;
  // INGEST_MAX_CONCURRENCY. The hard cap for every target, pinned or adaptive.
  // Raise it to allow more than DEFAULT_MAX_CONCURRENCY jobs at once.
  maxConcurrency: number;
  jobMemoryBytes: number;
};

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// Invalid env values fall back to the defaults, so a typo cannot stop the worker.
export function readConcurrencyConfig(
  env: Record<string, string | undefined> = process.env,
): ConcurrencyConfig {
  const jobMemoryMb = positiveNumber(env.INGEST_JOB_MEMORY_MB);
  return {
    pinned: positiveInteger(env.INGEST_CONCURRENCY) ?? null,
    maxConcurrency:
      positiveInteger(env.INGEST_MAX_CONCURRENCY) ?? DEFAULT_MAX_CONCURRENCY,
    jobMemoryBytes:
      jobMemoryMb === undefined ? DEFAULT_JOB_MEMORY_BYTES : jobMemoryMb * MIB,
  };
}

export type LimitName =
  | "memory"
  | "memory_unknown"
  | "cpu_ok"
  | "cpu_busy"
  | "cpu_saturated"
  | "memory_psi"
  | "io_psi"
  | "hard_cap"
  | "pinned";

export type ConcurrencyDecision = {
  target: number;
  // Target before the scale-up step limit was applied.
  computed: number;
  reason: LimitName;
  rateLimited: boolean;
  limits: {
    memory: number | null;
    cpu: number;
    cap: number;
  };
};

// Jobs that can be added inside the memory budget. The jobs already running are
// added back in, because their memory is already counted as used in the snapshot.
export function memoryBudget(
  snapshot: ResourceSnapshot,
  inFlight: number,
  jobMemoryBytes: number,
): number | null {
  if (snapshot.memAvailableBytes === null) return null;

  let headroom = snapshot.memAvailableBytes;
  let total = snapshot.memTotalBytes ?? snapshot.memAvailableBytes;
  if (snapshot.cgroupHeadroomBytes !== null) {
    headroom = Math.min(headroom, snapshot.cgroupHeadroomBytes);
  }
  if (snapshot.cgroupLimitBytes !== null) {
    total = Math.min(total, snapshot.cgroupLimitBytes);
  }

  const reserve = Math.max(
    MIN_MEMORY_RESERVE_BYTES,
    MEMORY_RESERVE_FRACTION * total,
  );
  const additional = Math.max(
    0,
    Math.floor((headroom - reserve) / jobMemoryBytes),
  );
  return inFlight + additional;
}

// CPU budget. Network-bound jobs let this exceed the core count, but load and
// PSI pull it back toward one job when the machine is busy.
export function cpuBudget(snapshot: ResourceSnapshot): {
  limit: number;
  reason: LimitName;
} {
  const cores = snapshot.cpuCount;
  const loadPerCore = snapshot.load1 / cores;
  const cpuPsi = snapshot.psi.cpuSome ?? 0;

  if (cpuPsi >= CPU_PSI_SEVERE || loadPerCore >= LOAD_PER_CORE_SEVERE) {
    return { limit: 1, reason: "cpu_saturated" };
  }
  if (cpuPsi >= CPU_PSI_STRESS || loadPerCore >= LOAD_PER_CORE_STRESS) {
    return { limit: cores, reason: "cpu_busy" };
  }
  return { limit: cores * NETWORK_JOBS_PER_CORE, reason: "cpu_ok" };
}

// Turns a snapshot into a target. The target is the smallest of the limits,
// and each limit is named so the log can say what bound it. Scale-up is limited to
// one job per check, and scale-down happens at once.
export function decideConcurrency(
  snapshot: ResourceSnapshot,
  options: {
    inFlight: number;
    previousTarget: number | null;
    config: ConcurrencyConfig;
  },
): ConcurrencyDecision {
  const { config, inFlight, previousTarget } = options;
  const cap = config.maxConcurrency;

  if (config.pinned !== null) {
    // A pin above the cap is clamped, so the cap is the only way past it.
    const pinned = Math.min(config.pinned, cap);
    return {
      target: pinned,
      computed: pinned,
      reason: config.pinned > cap ? "hard_cap" : "pinned",
      rateLimited: false,
      limits: { memory: null, cpu: pinned, cap },
    };
  }

  const memory = memoryBudget(snapshot, inFlight, config.jobMemoryBytes);
  const cpu = cpuBudget(snapshot);

  // Candidates are checked in order. A tie keeps the earlier reason.
  const candidates: { value: number; reason: LimitName }[] = [];
  if (memory === null) {
    candidates.push({
      value: UNKNOWN_MEMORY_FALLBACK,
      reason: "memory_unknown",
    });
  } else {
    candidates.push({ value: memory, reason: "memory" });
  }
  candidates.push({ value: cpu.limit, reason: cpu.reason });
  candidates.push({ value: cap, reason: "hard_cap" });
  if ((snapshot.psi.memorySome ?? 0) >= MEMORY_PSI_LIMIT) {
    candidates.push({ value: 1, reason: "memory_psi" });
  }
  if ((snapshot.psi.ioSome ?? 0) >= IO_PSI_LIMIT) {
    candidates.push({ value: 1, reason: "io_psi" });
  }

  let best = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate.value < best.value) best = candidate;
  }

  const computed = Math.max(1, Math.min(best.value, cap));
  const target =
    previousTarget === null || computed < previousTarget
      ? computed
      : Math.min(computed, previousTarget + 1);

  return {
    target,
    computed,
    reason: best.reason,
    rateLimited: target < computed,
    limits: { memory, cpu: cpu.limit, cap },
  };
}

// Keeps the latest decision, and calls onChange only when the target moves.
export function createConcurrencyController(options: {
  config: ConcurrencyConfig;
  readSnapshot: () => Promise<ResourceSnapshot>;
  onChange: (change: {
    previousTarget: number | null;
    decision: ConcurrencyDecision;
    snapshot: ResourceSnapshot;
    inFlight: number;
  }) => void | Promise<void>;
}) {
  let previousTarget: number | null = null;

  return async (inFlight: number): Promise<number> => {
    try {
      const snapshot = await options.readSnapshot();
      const decision = decideConcurrency(snapshot, {
        inFlight,
        previousTarget,
        config: options.config,
      });
      const before = previousTarget;
      // Record the target before logging, so a failing onChange cannot leave a
      // stale target in place for later checks.
      previousTarget = decision.target;
      if (decision.target !== before) {
        try {
          await options.onChange({
            previousTarget: before,
            decision,
            snapshot,
            inFlight,
          });
        } catch {
          // A logging failure must not change how many jobs run.
        }
      }
      return decision.target;
    } catch {
      // Keep the last target if a check fails. Hitting the floor here would be
      // worse than a stale value.
      return previousTarget ?? 1;
    }
  };
}
