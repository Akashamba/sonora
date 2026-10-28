import { spawn } from "node:child_process";
import { getPriority, setPriority } from "node:os";
import { logIngestInfo, logIngestWarning } from "~/utils/ingestLogger";

// Nice 10 lets other programs on the machine win the CPU when they need it.
// Children such as yt-dlp and ffmpeg inherit it because they are forked from the
// worker. Raising a nice value needs no privilege, so this is a per-process setting,
// not OS configuration.
export const WORKER_NICE = 10;

// Idle I/O class (-c3) only takes effect under I/O schedulers that honour
// priorities, such as BFQ. Under mq-deadline or none it is ignored.
// `ionice -p` sets the class on the main thread, and children forked from there
// inherit it. Idle I/O can also delay the worker's own SQLite writes while another
// process is busy on disk, so this is a trade-off.

export async function lowerWorkerPriority(
  deps: {
    nice?: (value: number) => void;
    readNice?: () => number;
    ioniceBinary?: string | null;
    runIonice?: (pid: number) => Promise<{ exitCode: number; stderr: string }>;
  } = {},
) {
  const nice = deps.nice ?? ((value: number) => setPriority(0, value));
  const readNice = deps.readNice ?? (() => getPriority(0));
  const ioniceBinary =
    deps.ioniceBinary !== undefined ? deps.ioniceBinary : findIonice();
  const runIonice = deps.runIonice ?? runIoniceIdle;

  try {
    nice(WORKER_NICE);
    await logIngestInfo("worker_priority_set", {
      pid: process.pid,
      nice: readNice(),
    });
  } catch (error) {
    // Android and some sandboxes refuse this call. The worker runs at its normal priority.
    await logIngestWarning("worker_priority_failed", error, {
      pid: process.pid,
      requestedNice: WORKER_NICE,
    });
  }

  if (ioniceBinary === null) {
    await logIngestInfo("worker_ionice_unavailable", { pid: process.pid });
    return;
  }
  try {
    const result = await runIonice(process.pid);
    if (result.exitCode === 0) {
      await logIngestInfo("worker_ionice_set", {
        pid: process.pid,
        ioClass: "idle",
      });
    } else {
      await logIngestWarning(
        "worker_ionice_failed",
        new Error(result.stderr.trim() || `ionice exited ${result.exitCode}`),
        { pid: process.pid, exitCode: result.exitCode },
      );
    }
  } catch (error) {
    await logIngestWarning("worker_ionice_failed", error, { pid: process.pid });
  }
}

function findIonice(): string | null {
  return Bun.which("ionice");
}

function runIoniceIdle(pid: number) {
  return new Promise<{ exitCode: number; stderr: string }>(
    (resolve, reject) => {
      const child = spawn("ionice", ["-c3", "-p", String(pid)], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (exitCode) =>
        resolve({ exitCode: exitCode ?? 1, stderr }),
      );
    },
  );
}
