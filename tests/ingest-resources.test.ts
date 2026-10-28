import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cgroupDirsFor,
  parseCgroupBytes,
  parseCgroupV2Path,
  parseMeminfo,
  parsePsiSome,
  readResourceSnapshot,
  type ResourcePaths,
} from "../src/workers/ingestTrack/resources";

const MEMINFO = `MemTotal:       15734808 kB
MemFree:          566284 kB
MemAvailable:   12899700 kB
Buffers:          120000 kB
`;

describe("resource file parsers", () => {
  test("meminfo gives MemTotal and MemAvailable in bytes", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      memTotalBytes: 15734808 * 1024,
      memAvailableBytes: 12899700 * 1024,
    });
  });

  test("meminfo without MemAvailable (old kernels) leaves it null", () => {
    expect(parseMeminfo("MemTotal: 2048 kB\nMemFree: 100 kB\n")).toEqual({
      memTotalBytes: 2048 * 1024,
      memAvailableBytes: null,
    });
  });

  test("empty or garbage meminfo gives nulls rather than throwing", () => {
    expect(parseMeminfo("")).toEqual({
      memTotalBytes: null,
      memAvailableBytes: null,
    });
    expect(parseMeminfo("MemTotal: lots kB")).toEqual({
      memTotalBytes: null,
      memAvailableBytes: null,
    });
  });

  test("cgroup v2 path is the 0:: line; a v1-only file has none", () => {
    const v2 = "12:pids:/x\n0::/user.slice/app.slice/t3.scope\n";
    expect(parseCgroupV2Path(v2)).toBe("/user.slice/app.slice/t3.scope");
    expect(parseCgroupV2Path("1:cpu:/a\n2:memory:/b\n")).toBeNull();
    expect(parseCgroupV2Path("")).toBeNull();
  });

  test("cgroup values: a byte count parses, 'max' and junk are null", () => {
    expect(parseCgroupBytes("2000000000\n")).toBe(2000000000);
    expect(parseCgroupBytes("max\n")).toBeNull();
    expect(parseCgroupBytes("")).toBeNull();
  });

  test("PSI reads some avg10 and ignores the full line", () => {
    const psi =
      "some avg10=11.81 avg60=2.58 avg300=0.57 total=798506178\n" +
      "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
    expect(parsePsiSome(psi)).toBe(11.81);
    expect(
      parsePsiSome("full avg10=7.00 avg60=0 avg300=0 total=1\n"),
    ).toBeNull();
    expect(parsePsiSome("")).toBeNull();
  });

  test("cgroup walk lists the cgroup then each ancestor, deepest first", () => {
    expect(cgroupDirsFor("/sys/fs/cgroup", "/a/b")).toEqual([
      "/sys/fs/cgroup/a/b",
      "/sys/fs/cgroup/a",
      "/sys/fs/cgroup",
    ]);
    expect(cgroupDirsFor("/sys/fs/cgroup", "/")).toEqual(["/sys/fs/cgroup"]);
  });
});

describe("readResourceSnapshot", () => {
  let dir: string;
  let paths: ResourcePaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sonora-resources-"));
    paths = {
      meminfo: join(dir, "meminfo"),
      pressureDir: join(dir, "pressure"),
      selfCgroup: join(dir, "self-cgroup"),
      cgroupRoot: join(dir, "cgroup"),
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("every file missing (Android/proot) gives nulls and does not throw", async () => {
    const snapshot = await readResourceSnapshot(paths);
    expect(snapshot.memTotalBytes).toBeNull();
    expect(snapshot.memAvailableBytes).toBeNull();
    expect(snapshot.cgroupLimitBytes).toBeNull();
    expect(snapshot.cgroupHeadroomBytes).toBeNull();
    expect(snapshot.psi).toEqual({
      cpuSome: null,
      memorySome: null,
      ioSome: null,
    });
    expect(snapshot.cpuCount).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(snapshot.load1)).toBe(true);
  });

  test("reads meminfo, PSI and the tightest ancestor cgroup limit", async () => {
    await writeFile(paths.meminfo, MEMINFO);
    await mkdir(paths.pressureDir, { recursive: true });
    await writeFile(
      join(paths.pressureDir, "cpu"),
      "some avg10=3.5 avg60=0 avg300=0 total=1\n",
    );
    await writeFile(
      join(paths.pressureDir, "memory"),
      "some avg10=0.25 avg60=0 avg300=0 total=1\n",
    );
    // io is deliberately missing.
    await writeFile(paths.selfCgroup, "0::/app/scope\n");

    // The scope has no limit. Its parent /app has 3 GB with 1 GB used.
    await mkdir(join(paths.cgroupRoot, "app", "scope"), { recursive: true });
    await writeFile(
      join(paths.cgroupRoot, "app", "scope", "memory.max"),
      "max\n",
    );
    await writeFile(
      join(paths.cgroupRoot, "app", "memory.max"),
      "3000000000\n",
    );
    await writeFile(
      join(paths.cgroupRoot, "app", "memory.current"),
      "1000000000\n",
    );

    const snapshot = await readResourceSnapshot(paths);
    expect(snapshot.memTotalBytes).toBe(15734808 * 1024);
    expect(snapshot.memAvailableBytes).toBe(12899700 * 1024);
    expect(snapshot.cgroupLimitBytes).toBe(3000000000);
    expect(snapshot.cgroupHeadroomBytes).toBe(2000000000);
    expect(snapshot.psi).toEqual({
      cpuSome: 3.5,
      memorySome: 0.25,
      ioSome: null,
    });
  });
});
