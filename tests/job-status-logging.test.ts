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
  tempDir = await mkdtemp(join(tmpdir(), "sonora-job-status-log-"));
  process.env.LOG_DIR = tempDir;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("job status logging", () => {
  test("records the final status, whether a track was saved, and write timings", async () => {
    // Runs in a child process with its own DB_FILE_NAME, as in download-file-logging.test.ts.
    const databasePath = join(tempDir, "test.sqlite");
    const probe = join(tempDir, "probe.ts");
    const dbModule = join(process.cwd(), "src/server/db/index.ts");
    const schemaModule = join(process.cwd(), "src/server/db/schema.ts");
    const settleModule = join(
      process.cwd(),
      "src/workers/ingestTrack/settleJob.ts",
    );
    await writeFile(
      probe,
      `import { sql, eq } from "drizzle-orm";
const { db } = await import(${JSON.stringify(dbModule)});
const { jobs } = await import(${JSON.stringify(schemaModule)});
const { settleJob } = await import(${JSON.stringify(settleModule)});
await db.run(sql\`CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY NOT NULL,
  url text NOT NULL,
  status text DEFAULT 'queued' NOT NULL,
  error text,
  claim_count integer DEFAULT 0 NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
)\`);
const insertJob = (id) => db.insert(jobs).values({ id, url: "https://youtube.com/watch?v=abcdefghijk", status: "running" }).run();
const statusOf = (id) => db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id)).get()?.status;
const result = {};

// Ingest saved the track, then the completed write hits a lock.
await db.run(sql\`CREATE TRIGGER fail_completed BEFORE UPDATE ON jobs WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'database is locked'); END\`);
insertJob("job-plain-success");
insertJob("job-saved-then-locked");
await settleJob({ id: "job-saved-then-locked", url: "u" }, async (progress) => { progress.trackCommitted = true; });
result.savedThenLocked = statusOf("job-saved-then-locked");
await db.run(sql\`DROP TRIGGER fail_completed\`);

// Plain success.
await settleJob({ id: "job-plain-success", url: "u" }, async (progress) => { progress.trackCommitted = true; });
result.plainSuccess = statusOf("job-plain-success");

// Ingest fails before any track is saved.
insertJob("job-failed");
await settleJob({ id: "job-failed", url: "u" }, async () => { throw new Error("metadata lookup failed"); });
result.plainFailure = statusOf("job-failed");

// Ingest fails and the failed write also hits a lock.
await db.run(sql\`CREATE TRIGGER fail_failed BEFORE UPDATE ON jobs WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'database is locked'); END\`);
insertJob("job-status-write-lost");
await settleJob({ id: "job-status-write-lost", url: "u" }, async () => { throw new Error("download failed"); });
result.statusWriteLost = statusOf("job-status-write-lost");
await db.run(sql\`DROP TRIGGER fail_failed\`);

console.log(JSON.stringify(result));
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
    const statuses = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(statuses).toEqual({
      savedThenLocked: "failed",
      plainSuccess: "completed",
      plainFailure: "failed",
      statusWriteLost: "running",
    });

    const all = await records();
    const forJob = (jobId: string) => all.filter((r) => r.jobId === jobId);

    const lockedCompletion = forJob("job-saved-then-locked");
    expect(lockedCompletion.map((r) => r.event)).toEqual([
      "job_completion_status_update_failed",
      "job_marked_failed",
    ]);
    expect(lockedCompletion[0]).toMatchObject({
      level: "error",
      stage: "job_status_update",
      attemptedStatus: "completed",
      finalStatus: null,
      trackCommitted: true,
    });
    expect(typeof lockedCompletion[0].durationMs).toBe("number");
    expect(lockedCompletion[1]).toMatchObject({
      level: "info",
      finalStatus: "failed",
      trackCommitted: true,
    });
    expect(typeof lockedCompletion[1].durationMs).toBe("number");
    expect(lockedCompletion[1].ingestError).toEqual(expect.any(String));

    const success = forJob("job-plain-success");
    expect(success).toHaveLength(1);
    expect(success[0]).toMatchObject({
      event: "job_completed",
      level: "info",
      finalStatus: "completed",
      trackCommitted: true,
    });
    expect(typeof success[0].durationMs).toBe("number");

    const plainFailure = forJob("job-failed");
    expect(plainFailure).toHaveLength(1);
    expect(plainFailure[0]).toMatchObject({
      event: "job_marked_failed",
      finalStatus: "failed",
      trackCommitted: false,
      ingestError: "metadata lookup failed",
    });

    const lostWrite = forJob("job-status-write-lost");
    expect(lostWrite).toHaveLength(1);
    expect(lostWrite[0]).toMatchObject({
      event: "job_failure_status_update_failed",
      level: "error",
      attemptedStatus: "failed",
      finalStatus: null,
      trackCommitted: false,
      ingestError: "download failed",
    });
    expect(typeof lostWrite[0].durationMs).toBe("number");
  }, 20000);
});
