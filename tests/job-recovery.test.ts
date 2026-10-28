import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  drainPoolWithGrace,
  createOwnedJobs,
  readShutdownGraceMs,
  DEFAULT_SHUTDOWN_GRACE_MS,
} from "../src/workers/ingestTrack/shutdown";

let tempDir: string;
let databasePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-job-recovery-"));
  databasePath = join(tempDir, "tracks.sqlite");
  const db = new Database(databasePath);
  db.exec(
    await Bun.file(
      new URL("./fixtures/playlist-schema.sql", import.meta.url),
    ).text(),
  );
  // claim_count 1 is a first claim, 3 is the poison limit.
  const insert = db.prepare(
    "INSERT INTO jobs (id, url, status, claim_count, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
  );
  insert.run("job-first", "https://youtu.be/a", "running", 1);
  insert.run("job-poison", "https://youtu.be/b", "running", 3);
  insert.run("job-other-running", "https://youtu.be/c", "running", 1);
  insert.run("job-queued", "https://youtu.be/d", "queued", 0);
  insert.run("job-done", "https://youtu.be/e", "completed", 1);
  db.close();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// Runs recovery in a child process with its own DB_FILE_NAME, so the db module never
// points at a real database.
async function runProbe(body: string) {
  const probe = join(tempDir, `probe-${crypto.randomUUID()}.ts`);
  await writeFile(
    probe,
    `const recover = await import(${JSON.stringify(join(process.cwd(), "src/workers/ingestTrack/recoverJobs.ts"))});
${body}
`,
  );
  const child = Bun.spawn(["bun", probe], {
    cwd: process.cwd(),
    env: { ...process.env, DB_FILE_NAME: databasePath, LOG_DIR: tempDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const line = stdout.split("\n").find((text) => text.startsWith("RESULT "));
  return JSON.parse(line!.slice("RESULT ".length));
}

function jobRows() {
  const db = new Database(databasePath, { readonly: true });
  const rows = db
    .query(
      "SELECT id, status, claim_count AS claimCount, error FROM jobs ORDER BY id",
    )
    .all() as {
    id: string;
    status: string;
    claimCount: number;
    error: string | null;
  }[];
  db.close();
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

async function ingestRecords() {
  const file = join(
    tempDir,
    `ingest-${new Date().toLocaleDateString("en-CA")}.jsonl`,
  );
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("startup recovery of running jobs", () => {
  test("requeues running jobs under the claim limit, fails poison jobs, keeps claim_count", async () => {
    const result = await runProbe(`
      const out = await recover.requeueAndLog(null, "startup");
      console.log("RESULT " + JSON.stringify(out));
    `);

    expect(result.requeued.sort()).toEqual(["job-first", "job-other-running"]);
    expect(result.failed).toEqual(["job-poison"]);

    const rows = jobRows();
    expect(rows["job-first"]).toMatchObject({
      status: "queued",
      claimCount: 1,
    });
    expect(rows["job-other-running"]).toMatchObject({
      status: "queued",
      claimCount: 1,
    });
    expect(rows["job-poison"]).toMatchObject({
      status: "failed",
      claimCount: 3,
    });
    expect(rows["job-poison"]!.error).toContain("3 times");
    // Rows that were not running are left alone.
    expect(rows["job-queued"]).toMatchObject({
      status: "queued",
      claimCount: 0,
    });
    expect(rows["job-done"]).toMatchObject({
      status: "completed",
      claimCount: 1,
    });
  });

  test("logs jobs_requeued_at_startup with the ids", async () => {
    await runProbe(`
      await recover.requeueAndLog(null, "startup");
      console.log("RESULT {}");
    `);

    const record = (await ingestRecords()).find(
      (r) => r.event === "jobs_requeued_at_startup",
    );
    expect(record).toMatchObject({ level: "info", jobCount: 2 });
    expect(record!.jobIds.sort()).toEqual(["job-first", "job-other-running"]);
  });
});

describe("shutdown recovery only touches this process's jobs", () => {
  test("hands back only the listed running jobs", async () => {
    const result = await runProbe(`
      const out = await recover.requeueAndLog(["job-other-running", "job-queued"], "shutdown");
      console.log("RESULT " + JSON.stringify(out));
    `);

    expect(result.requeued).toEqual(["job-other-running"]);
    const rows = jobRows();
    expect(rows["job-other-running"]?.status).toBe("queued");
    expect(rows["job-first"]?.status).toBe("running");
    expect(rows["job-poison"]?.status).toBe("running");
  });
});

describe("drainPoolWithGrace", () => {
  test("returns without requeueing when the pool drains inside the grace period", async () => {
    const owned = createOwnedJobs();
    owned.add(["a"]);
    const pool = new Promise<void>((resolve) =>
      setTimeout(() => {
        owned.delete("a");
        resolve();
      }, 10),
    );
    const requeued: string[][] = [];

    const out = await drainPoolWithGrace({
      pool,
      graceMs: 1000,
      owned,
      requeue: async (ids) => void requeued.push(ids),
    });

    expect(out.outcome).toBe("drained");
    expect(requeued).toEqual([]);
  });

  test("after the grace period hands back the jobs still owned", async () => {
    const owned = createOwnedJobs();
    owned.add(["stuck-1", "stuck-2"]);
    const pool = new Promise<void>(() => {});
    const requeued: string[][] = [];

    const out = await drainPoolWithGrace({
      pool,
      graceMs: 20,
      owned,
      requeue: async (ids) => void requeued.push(ids),
    });

    expect(out.outcome).toBe("expired");
    expect(requeued).toEqual([["stuck-1", "stuck-2"]]);
  });

  test("reads the grace period from the environment, with a default", () => {
    expect(readShutdownGraceMs({})).toBe(DEFAULT_SHUTDOWN_GRACE_MS);
    expect(readShutdownGraceMs({ WORKER_SHUTDOWN_GRACE_MS: "500" })).toBe(500);
    expect(readShutdownGraceMs({ WORKER_SHUTDOWN_GRACE_MS: "nope" })).toBe(
      DEFAULT_SHUTDOWN_GRACE_MS,
    );
  });
});
