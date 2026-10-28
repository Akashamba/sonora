import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a write waits for another process's lock instead of failing with SQLITE_BUSY", async () => {
  // Nothing in this process imports src/server/db. That module opens its DB once at import, so
  // loading it here would pin every later test file in the shared process to this temp DB.
  const file = join(await mkdtemp(join(tmpdir(), "sonora-busy-")), "test.sqlite");
  const setup = new Database(file);
  setup.run("CREATE TABLE t (v integer)");
  setup.close();

  // A second connection, standing in for the other process, holds the write lock for 300ms.
  const other = new Database(file);
  other.run("BEGIN IMMEDIATE");
  other.run("INSERT INTO t VALUES (1)");
  setTimeout(() => other.run("COMMIT"), 300);

  // Run the write in a child so the timer above can fire while it waits on the lock.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `process.env.DB_FILE_NAME=${JSON.stringify(file)};
       const { db } = await import(${JSON.stringify(join(process.cwd(), "src/server/db/index.ts"))});
       const { sql } = await import("drizzle-orm");
       db.run(sql\`INSERT INTO t VALUES (2)\`);`,
    ],
    { stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  expect(other.query("SELECT count(*) AS c FROM t").get()).toEqual({ c: 2 });
  other.close();
});
