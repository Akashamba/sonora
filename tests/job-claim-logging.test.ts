import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;

const todayLog = () =>
  join(
    process.env.LOG_DIR!,
    `ingest-${new Date().toLocaleDateString("en-CA")}.jsonl`,
  );
async function records() {
  try {
    return (await readFile(todayLog(), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-job-claim-log-"));
  process.env.LOG_DIR = tempDir;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("job claim and timing logging", () => {
  test("claim sets updated_at and counts claims; ingest records carry queue and total timings", async () => {
    // Runs in a child process with its own DB_FILE_NAME, as in job-status-logging.test.ts.
    const databasePath = join(tempDir, "test.sqlite");
    const probe = join(tempDir, "probe.ts");
    const dbModule = join(process.cwd(), "src/server/db/index.ts");
    const schemaModule = join(process.cwd(), "src/server/db/schema.ts");
    const claimModule = join(
      process.cwd(),
      "src/workers/ingestTrack/claimJobs.ts",
    );
    const ingestModule = join(process.cwd(), "src/services/ingestTrack.ts");
    await writeFile(
      probe,
      `import { sql, eq } from "drizzle-orm";
const { db } = await import(${JSON.stringify(dbModule)});
const { jobs } = await import(${JSON.stringify(schemaModule)});
const { claimJobs } = await import(${JSON.stringify(claimModule)});
const { ingestTrack } = await import(${JSON.stringify(ingestModule)});
await db.run(sql\`CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY NOT NULL,
  url text NOT NULL,
  status text DEFAULT 'queued' NOT NULL,
  error text,
  claim_count integer DEFAULT 0 NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
)\`);
// Created five seconds ago, so the queue wait is at least that long.
const createdAt = new Date(Date.now() - 5000);
await db.insert(jobs).values({ id: "job-claim", url: "not youtube", created_at: createdAt, updated_at: createdAt }).run();

const [first] = await claimJobs(2);
const afterFirst = db.select().from(jobs).where(eq(jobs.id, "job-claim")).get();
await ingestTrack(first.url, first.id, {}, { queuedForMs: first.queuedForMs }).catch(() => {});

// Requeued (as a future requeue would do), then claimed again.
await db.update(jobs).set({ status: "queued" }).where(eq(jobs.id, "job-claim")).run();
const [second] = await claimJobs(2);
const afterSecond = db.select().from(jobs).where(eq(jobs.id, "job-claim")).get();
const none = await claimJobs(2);

console.log(JSON.stringify({
  first: { claimCount: first.claimCount, queuedForMs: first.queuedForMs, updatedAt: afterFirst.updated_at.getTime(), status: afterFirst.status },
  second: { claimCount: second.claimCount, status: afterSecond.status, updatedAt: afterSecond.updated_at.getTime() },
  createdAt: createdAt.getTime(),
  none: none.length,
}));
`,
    );
    const child = Bun.spawn(["bun", probe], {
      cwd: process.cwd(),
      env: { ...process.env, DB_FILE_NAME: databasePath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);

    expect(result.first.status).toBe("running");
    expect(result.first.claimCount).toBe(1);
    expect(result.first.queuedForMs).toBeGreaterThanOrEqual(5000);
    expect(result.first.updatedAt).toBeGreaterThanOrEqual(result.createdAt + 5000);
    expect(result.second).toEqual({
      claimCount: 2,
      status: "running",
      updatedAt: expect.any(Number),
    });
    expect(result.second.updatedAt).toBeGreaterThanOrEqual(result.first.updatedAt);
    expect(result.none).toBe(0);

    const all = await records();
    const forJob = (jobId: string) => all.filter((r) => r.jobId === jobId);

    // The stage events reach the file, not just stdout.
    const job = forJob("job-claim");
    expect(job.map((r) => r.event)).toEqual([
      "ingest_started",
      "ingest_stage_started",
      "ingest_failed",
    ]);
    expect(job[0]).toMatchObject({ level: "info", sourceUrl: "not youtube" });
    expect(job[1]).toMatchObject({ level: "info", stage: "parse_youtube_url" });

    // The failure record has the whole-job time and the queue wait.
    expect(job[2]).toMatchObject({
      level: "error",
      stage: "parse_youtube_url",
      queuedForMs: result.first.queuedForMs,
    });
    expect(typeof job[2].totalDurationMs).toBe("number");
    expect(job[2].totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(job[2].error.message).toEqual(expect.any(String));
    expect(Object.hasOwn(job[2], "errorKind")).toBe(false);
  }, 20000);
});
