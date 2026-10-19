import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { errorKindFields } from "~/utils/networkErrors";

type LogFields = Record<string, unknown>;

// Keeps `timestamp` in UTC and adds the zone it was taken in so the record can
// be read back in local time.
function timeFields(now: Date) {
  return {
    timestamp: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcOffset: formatUtcOffset(now),
  };
}

function formatUtcOffset(now: Date) {
  const minutes = -now.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// Calendar date in the process's local timezone, as YYYY-MM-DD.
function localDate(now: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function errorDetails(error: unknown): LogFields {
  if (error instanceof Error) {
    const details = error as Error & {
      cause?: unknown;
      code?: string | number;
      exitCode?: number;
      signal?: string;
      stderr?: unknown;
      stdout?: unknown;
      service?: unknown;
      host?: unknown;
      url?: unknown;
      status?: unknown;
      json?: unknown;
    };
    const cause = details.cause;
    const output = (value: unknown) => {
      if (value === undefined || value === null) return undefined;
      const text = String(value);
      return text.length > 8000 ? `${text.slice(0, 8000)}…[truncated]` : text;
    };

    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(details.code === undefined ? {} : { code: details.code }),
      ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
      ...(details.signal === undefined ? {} : { signal: details.signal }),
      ...(details.stderr === undefined
        ? {}
        : { stderr: output(details.stderr) }),
      ...(details.stdout === undefined
        ? {}
        : { stdout: output(details.stdout) }),
      ...(details.service === undefined ? {} : { service: details.service }),
      ...(details.host === undefined ? {} : { host: details.host }),
      ...(details.url === undefined ? {} : { url: details.url }),
      ...(details.status === undefined ? {} : { status: details.status }),
      ...(details.json === undefined ? {} : { json: details.json }),
      ...(cause === undefined ? {} : { cause: String(cause) }),
    };
  }

  return { message: String(error) };
}

function logDirectory() {
  return resolve(process.env.LOG_DIR ?? "logs");
}

function errorLogPath(date: string) {
  return join(logDirectory(), `ingest-${date}.jsonl`);
}

// Writes a standalone file under LOG_DIR, such as a raw API response, and
// returns its path relative to LOG_DIR so a log record can point at it. Throws
// on failure; callers decide whether a missing artifact matters.
export async function writeLogArtifact(relativePath: string, content: string) {
  const path = join(logDirectory(), relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return relativePath;
}

// Keep concurrent worker writes ordered and each JSON record on its own line.
let writeQueue: Promise<void> = Promise.resolve();

async function writeErrorRecord(record: LogFields, now: Date) {
  const path = errorLogPath(localDate(now));
  const line = `${JSON.stringify(record)}\n`;

  writeQueue = writeQueue
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line, "utf8");
    })
    .catch((error: unknown) => {
      // A logging failure must not replace or hide the original ingest error.
      console.error(
        JSON.stringify({
          ...timeFields(new Date()),
          level: "error",
          event: "ingest_log_write_failed",
          logPath: path,
          ...errorDetails(error),
        }),
      );
    });

  await writeQueue;
}

export function logIngestSuccess(event: string, fields: LogFields = {}) {
  console.log(
    JSON.stringify({
      ...timeFields(new Date()),
      level: "info",
      event,
      ...fields,
    }),
  );
}

// Prints the event like logIngestSuccess and also appends it to the day's jsonl file.
export async function logIngestInfo(event: string, fields: LogFields = {}) {
  logIngestSuccess(event, fields);
  const now = new Date();
  await writeErrorRecord(
    {
      ...timeFields(now),
      level: "info",
      event,
      ...fields,
    },
    now,
  );
}

export async function logIngestFailure(
  event: string,
  error: unknown,
  fields: LogFields = {},
) {
  const now = new Date();
  await writeErrorRecord(
    {
      ...timeFields(now),
      level: "error",
      event,
      ...fields,
      error: errorDetails(error),
    },
    now,
  );
}

export async function logIngestWarning(
  event: string,
  error: unknown,
  fields: LogFields = {},
) {
  const now = new Date();
  await writeErrorRecord(
    {
      ...timeFields(now),
      level: "warning",
      event,
      ...fields,
      error: errorDetails(error),
    },
    now,
  );
}

export type ExternalCallRecord = { status?: number; retryAfter?: string };

const DEFAULT_EXTERNAL_CALL_SLOW_MS = 60000;

// Read at call time so the env value can change without a restart.
function externalCallSlowMs(): number {
  const parsed = Number(process.env.EXTERNAL_CALL_SLOW_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_EXTERNAL_CALL_SLOW_MS;
}

// Wraps one external call and emits `external_call_finished` exactly once, on
// success and on failure (before the error propagates). `call` can set
// `record.status` when an HTTP response arrived and `record.retryAfter` for its
// Retry-After header.
// A call still pending after EXTERNAL_CALL_SLOW_MS (default 60s) gets one
// `external_call_slow` record. The call is not aborted.
export async function logExternalCall<T>(
  fields: LogFields,
  call: (record: ExternalCallRecord) => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const record: ExternalCallRecord = {};
  const thresholdMs = externalCallSlowMs();

  const watchdog = setTimeout(() => {
    // Not awaited: the call is still pending and a log failure must not reject it.
    logIngestInfo("external_call_slow", {
      ...fields,
      elapsedMs: Math.round(performance.now() - startedAt),
      thresholdMs,
    }).catch(() => {});
  }, thresholdMs);
  // The watchdog alone must not keep the process alive.
  watchdog.unref();

  let result: T;
  try {
    result = await call(record);
  } catch (error) {
    clearTimeout(watchdog);
    await logIngestInfo("external_call_finished", {
      ...fields,
      durationMs: Math.round(performance.now() - startedAt),
      outcome: "error",
      ...(record.status === undefined ? {} : { status: record.status }),
      ...(record.retryAfter === undefined
        ? {}
        : { retryAfter: record.retryAfter }),
      ...errorKindFields(error),
    });
    throw error;
  }

  clearTimeout(watchdog);
  await logIngestInfo("external_call_finished", {
    ...fields,
    durationMs: Math.round(performance.now() - startedAt),
    outcome: "ok",
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.retryAfter === undefined
      ? {}
      : { retryAfter: record.retryAfter }),
  });
  return result;
}
