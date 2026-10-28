import { constants } from "node:os";
import { logIngestFailure, logIngestInfo } from "~/utils/ingestLogger";

// Writes the worker's start, its stop signals and its crashes to the ingest log.
// The first stop signal runs `stop` (wait for running jobs, hand back the rest)
// and then exits. A second signal exits at once. Crashes still exit non-zero.
export async function logWorkerLifecycle(
  exit: (code: number) => void = process.exit,
  options: {
    stop?: (signal: "SIGINT" | "SIGTERM") => Promise<void>;
    // Runs before every exit. A process killed by a signal runs no exit hooks, so
    // this is where the worker kills the commands it still has running.
    beforeExit?: () => void;
  } = {},
) {
  const exitWith = (code: number) => {
    options.beforeExit?.();
    exit(code);
  };
  await logIngestInfo("worker_started", { pid: process.pid });

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      // Same status a shell reports for a process that died from this signal.
      const code = 128 + constants.signals[signal];
      if (stopping) {
        await logIngestInfo("worker_force_stop", { signal });
        exitWith(code);
        return;
      }
      stopping = true;
      await logIngestInfo("worker_stopping", { signal });
      if (options.stop) {
        try {
          await options.stop(signal);
        } catch (error) {
          await logIngestFailure("worker_stop_failed", error, { signal });
        }
      }
      exitWith(code);
    });
  }

  process.on("uncaughtException", (error) =>
    exitAfterFatalError("uncaught_exception", error, exitWith),
  );
  process.on("unhandledRejection", (error) =>
    exitAfterFatalError("unhandled_rejection", error, exitWith),
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
