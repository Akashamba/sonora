import { logIngestFailure } from "~/utils/ingestLogger";

// SQLite error code such as SQLITE_BUSY. Drizzle can wrap the driver error, so
// the code is also looked for on the cause.
function sqliteCodeOf(error: unknown): string | undefined {
  const own = (error as { code?: unknown } | null)?.code;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  const code = own ?? cause;
  return typeof code === "string" ? code : undefined;
}

// Logs a database failure from a route to the ingest jsonl file and returns the
// same 500 the route sends for its other failures.
export async function routeDbError(
  event: "route_db_write_failed" | "route_db_read_failed",
  route: string,
  req: Request,
  error: unknown,
) {
  await logIngestFailure(event, error, {
    route,
    method: req.method,
    code: sqliteCodeOf(error),
  });
  return new Response("INTERNAL SERVER ERROR", { status: 500 });
}
