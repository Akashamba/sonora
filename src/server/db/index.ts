import "dotenv/config";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";

const sqlite = new Database(process.env.DB_FILE_NAME!);
// The server and the ingest worker write from separate processes. Without a busy
// timeout a write that collides with the other process fails at once with
// SQLITE_BUSY instead of waiting for the lock. Per connection, not stored in the DB.
sqlite.run("PRAGMA busy_timeout = 5000");
export const db = drizzle({ client: sqlite });
