import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

type LogFields = Record<string, unknown>;

function timestamp() {
  return new Date().toISOString();
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
      ...(cause === undefined ? {} : { cause: String(cause) }),
    };
  }

  return { message: String(error) };
}

function errorLogPath(date: string) {
  const directory = resolve(process.env.LOG_DIR ?? "logs");
  return join(directory, `ingest-${date}.jsonl`);
}

// Keep concurrent worker writes ordered and each JSON record on its own line.
let writeQueue: Promise<void> = Promise.resolve();

async function writeErrorRecord(record: LogFields) {
  const date = new Date().toISOString().slice(0, 10);
  const path = errorLogPath(date);
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
          timestamp: timestamp(),
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
      timestamp: timestamp(),
      level: "info",
      event,
      ...fields,
    }),
  );
}

// Prints the event like logIngestSuccess and also appends it to the day's jsonl file.
export async function logIngestInfo(event: string, fields: LogFields = {}) {
  logIngestSuccess(event, fields);
  await writeErrorRecord({
    timestamp: timestamp(),
    level: "info",
    event,
    ...fields,
  });
}

export async function logIngestFailure(
  event: string,
  error: unknown,
  fields: LogFields = {},
) {
  await writeErrorRecord({
    timestamp: timestamp(),
    level: "error",
    event,
    ...fields,
    error: errorDetails(error),
  });
}

export async function logIngestWarning(
  event: string,
  error: unknown,
  fields: LogFields = {},
) {
  await writeErrorRecord({
    timestamp: timestamp(),
    level: "warning",
    event,
    ...fields,
    error: errorDetails(error),
  });
}
