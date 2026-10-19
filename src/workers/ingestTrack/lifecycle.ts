import { constants } from "node:os";
import { logIngestFailure, logIngestInfo } from "~/utils/ingestLogger";

// Writes the worker's start, its stop signals and its crashes to the ingest log.
// The handlers only add records: crashes still exit non-zero and stop signals
// still stop the worker.
export async function logWorkerLifecycle(
  exit: (code: number) => void = process.exit,
) {
  await logIngestInfo("worker_started", { pid: process.pid });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await logIngestInfo("worker_stopping", { signal });
      // Same status a shell reports for a process that died from this signal.
      exit(128 + constants.signals[signal]);
    });
  }

  process.on("uncaughtException", (error) =>
    exitAfterFatalError("uncaught_exception", error, exit),
  );
  process.on("unhandledRejection", (error) =>
    exitAfterFatalError("unhandled_rejection", error, exit),
  );
}

async function exitAfterFatalError(
  event: string,
  error: unknown,
  exit: (code: number) => void,
) {
  // Print first so the error still reaches stderr even if the log write fails.
  console.error(error);
  await logIngestFailure(event, error);
  exit(1);
}
