import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let server: Bun.Subprocess | undefined;

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
  tempDir = await mkdtemp(join(tmpdir(), "sonora-import-log-"));
  process.env.LOG_DIR = tempDir;
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  server?.kill();
  server = undefined;
});

describe("import logging", () => {
  test("expansion failures log playlist_expansion, job creation failures log queue_creation, and created jobs list their ids", async () => {
    // The server runs in a child process with its own DB_FILE_NAME. PATH points at an
    // empty directory so yt-dlp cannot run and playlist expansion fails.
    const { Database } = await import("bun:sqlite");
    const databasePath = join(tempDir, "test.sqlite");
    const emptyBin = join(tempDir, "empty-bin");
    await mkdir(emptyBin);
    const setup = new Database(databasePath);
    // Same columns as the jobs table in src/server/db/schema.ts.
    setup.run(`CREATE TABLE jobs (
      id text PRIMARY KEY NOT NULL,
      url text NOT NULL,
      status text DEFAULT 'queued' NOT NULL,
      error text,
      claim_count integer DEFAULT 0 NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )`);

    const port = 20000 + Math.floor(Math.random() * 20000);
    server = Bun.spawn([process.execPath, "src/server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_FILE_NAME: databasePath,
        BIND_HOST: "127.0.0.1",
        BIND_PORT: String(port),
        DEMO_MODE: "false",
        PATH: emptyBin,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
      try {
        await fetch(`${base}/`);
        break;
      } catch (error) {
        if (attempt > 100) throw error;
        await Bun.sleep(100);
      }
    }

    const post = (url: string) =>
      fetch(`${base}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

    // Playlist expansion fails (yt-dlp is not on PATH): 500, stage playlist_expansion.
    const expansion = await post("https://www.youtube.com/playlist?list=PL1");
    expect(expansion.status).toBe(500);
    expect(await expansion.json()).toEqual({
      message: "failed to create import jobs",
    });

    // Single video: no expansion needed, one job is created.
    const created = await post("https://www.youtube.com/watch?v=abc");
    expect(created.status).toBe(200);
    const jobRows = setup.query("SELECT id FROM jobs").all() as { id: string }[];

    // Jobs table gone: job creation fails, stage queue_creation.
    setup.run("DROP TABLE jobs");
    const queueFailure = await post("https://www.youtube.com/watch?v=def");
    expect(queueFailure.status).toBe(500);
    expect(await queueFailure.json()).toEqual({
      message: "failed to create import jobs",
    });
    setup.close();

    const all = await records();
    const expansionFailure = all.find(
      (r) => r.event === "import_playlist_expansion_failed",
    );
    expect(expansionFailure.level).toBe("error");
    expect(expansionFailure.stage).toBe("playlist_expansion");
    expect(expansionFailure.requestId).toEqual(expect.any(String));
    expect(expansionFailure.error.message).toEqual(expect.any(String));

    const queueRecord = all.find(
      (r) => r.event === "import_queue_creation_failed",
    );
    expect(queueRecord.level).toBe("error");
    expect(queueRecord.stage).toBe("queue_creation");
    expect(queueRecord.urlCount).toBe(1);
    expect(queueRecord.error.message).toContain("jobs");

    const createdRecord = all.find((r) => r.event === "import_jobs_created");
    expect(createdRecord.level).toBe("info");
    expect(createdRecord.jobCount).toBe(1);
    expect(createdRecord.jobIds).toEqual(jobRows.map((row) => row.id));
    expect(createdRecord.requestId).not.toBe(expansionFailure.requestId);
    expect(createdRecord.requestId).not.toBe(queueRecord.requestId);
  }, 30000);
});
