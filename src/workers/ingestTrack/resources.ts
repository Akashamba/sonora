import { readFile } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";

// Practice this file follows, from the kernel PSI docs (Documentation/accounting/psi.rst)
// and how systemd-oomd / earlyoom judge memory:
// - Memory availability comes from MemAvailable, the kernel's estimate of memory
//   that can be handed out without swapping (it counts reclaimable page cache).
//   os.freemem() only reports truly free pages and would make a busy machine look full.
// - PSI `some avg10` is the share of the last 10 seconds in which at least one task
//   stalled waiting on a resource. It is the same kind of signal systemd-oomd uses to
//   act before the kernel OOM killer does. We use it only to decide how many NEW jobs
//   to start. Nothing here kills a process.
// - A missing PSI file means "no signal", not "no pressure". Kernels without PSI,
//   Android and proot often lack /proc/pressure, and those cases must still work.
// - cgroup v2 limits (memory.max, memory.current) are read for this process's cgroup
//   and each ancestor, because a parent slice can impose the tighter limit.
//   memory.current includes page cache, so cgroup headroom is conservative.
// - Load average lags by minutes, so it only backs off a sustained overload.

export type ResourceSnapshot = {
  takenAt: number;
  cpuCount: number;
  load1: number;
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
  // Tightest cgroup limit that applies to this process, and what is left under it.
  cgroupLimitBytes: number | null;
  cgroupHeadroomBytes: number | null;
  psi: {
    cpuSome: number | null;
    memorySome: number | null;
    ioSome: number | null;
  };
};

export type ResourcePaths = {
  meminfo: string;
  pressureDir: string;
  selfCgroup: string;
  cgroupRoot: string;
};

export const DEFAULT_RESOURCE_PATHS: ResourcePaths = {
  meminfo: "/proc/meminfo",
  pressureDir: "/proc/pressure",
  selfCgroup: "/proc/self/cgroup",
  cgroupRoot: "/sys/fs/cgroup",
};

const KIB = 1024;

// Returns the values this module needs from /proc/meminfo. Missing keys stay null.
export function parseMeminfo(text: string): {
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
} {
  const kibFor = (key: string) => {
    const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
    return match ? Number(match[1]) * KIB : null;
  };
  return {
    memTotalBytes: kibFor("MemTotal"),
    memAvailableBytes: kibFor("MemAvailable"),
  };
}

// The cgroup v2 line is "0::/some/path". A v1-only process has no such line.
export function parseCgroupV2Path(text: string): string | null {
  for (const line of text.split("\n")) {
    if (line.startsWith("0::")) return line.slice(3) || "/";
  }
  return null;
}

// memory.max and memory.current hold a byte count, or "max" when unlimited.
export function parseCgroupBytes(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

// Reads `some avg10` from a PSI file. The `full` line is ignored because it means
// every task was stalled, which is a stronger condition than we need.
export function parsePsiSome(text: string): number | null {
  const match = text.match(/^some\s+avg10=([\d.]+)/m);
  return match ? Number(match[1]) : null;
}

// Lists a cgroup and each ancestor, deepest first, so "/a/b" gives
// ["/a/b", "/a", "/"] under cgroupRoot.
export function cgroupDirsFor(
  cgroupRoot: string,
  relativePath: string,
): string[] {
  const parts = relativePath.split("/").filter(Boolean);
  const dirs: string[] = [];
  for (let depth = parts.length; depth >= 0; depth--) {
    dirs.push(
      depth === 0
        ? cgroupRoot
        : `${cgroupRoot}/${parts.slice(0, depth).join("/")}`,
    );
  }
  return dirs;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// Walks this process's cgroup and its ancestors, and keeps the tightest headroom.
async function readCgroupHeadroom(
  paths: ResourcePaths,
): Promise<{ limitBytes: number | null; headroomBytes: number | null }> {
  const selfText = await readOptional(paths.selfCgroup);
  const relativePath = selfText ? parseCgroupV2Path(selfText) : null;
  if (relativePath === null) return { limitBytes: null, headroomBytes: null };

  let limitBytes: number | null = null;
  let headroomBytes: number | null = null;
  for (const dir of cgroupDirsFor(paths.cgroupRoot, relativePath)) {
    const max = parseCgroupBytes(
      (await readOptional(`${dir}/memory.max`)) ?? "",
    );
    if (max === null) continue; // "max" (unlimited) or the file is absent
    const current = parseCgroupBytes(
      (await readOptional(`${dir}/memory.current`)) ?? "",
    );
    if (current === null) continue;
    const headroom = Math.max(0, max - current);
    if (limitBytes === null || max < limitBytes) limitBytes = max;
    if (headroomBytes === null || headroom < headroomBytes)
      headroomBytes = headroom;
  }
  return { limitBytes, headroomBytes };
}

// Reads every probe. Each read is independent and nothing throws, so a missing
// file on Android or proot only removes that one signal.
export async function readResourceSnapshot(
  paths: ResourcePaths = DEFAULT_RESOURCE_PATHS,
): Promise<ResourceSnapshot> {
  const meminfo = parseMeminfo((await readOptional(paths.meminfo)) ?? "");
  const psiText = async (name: string) =>
    parsePsiSome((await readOptional(`${paths.pressureDir}/${name}`)) ?? "");
  const cgroup = await readCgroupHeadroom(paths);

  return {
    takenAt: Date.now(),
    cpuCount: Math.max(1, availableParallelism()),
    load1: loadavg()[0] ?? 0,
    memTotalBytes: meminfo.memTotalBytes,
    memAvailableBytes: meminfo.memAvailableBytes,
    cgroupLimitBytes: cgroup.limitBytes,
    cgroupHeadroomBytes: cgroup.headroomBytes,
    psi: {
      cpuSome: await psiText("cpu"),
      memorySome: await psiText("memory"),
      ioSome: await psiText("io"),
    },
  };
}
