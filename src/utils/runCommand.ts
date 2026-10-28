// Runs an external command with a time limit. Bun's shell has no timeout, so a stalled
// yt-dlp or ffprobe would hold its pool slot forever. On timeout the child is killed
// and the error carries errorKind "timeout", so the external-call logging and the
// retry paths treat it like any other transient network failure.

export type CommandTimeoutKey =
  "ytDlpMetadata" | "ytDlpDownload" | "ytDlpPlaylist" | "ffprobe";

const TIMEOUT_DEFAULTS_MS: Record<CommandTimeoutKey, number> = {
  ytDlpMetadata: 60_000,
  ytDlpDownload: 15 * 60_000,
  ytDlpPlaylist: 120_000,
  ffprobe: 30_000,
};

const TIMEOUT_ENV: Record<CommandTimeoutKey, string> = {
  ytDlpMetadata: "YT_DLP_METADATA_TIMEOUT_MS",
  ytDlpDownload: "YT_DLP_DOWNLOAD_TIMEOUT_MS",
  ytDlpPlaylist: "YT_DLP_PLAYLIST_TIMEOUT_MS",
  ffprobe: "FFPROBE_TIMEOUT_MS",
};

// Read on each call, so a changed env applies without a restart of the module.
export function commandTimeoutMs(key: CommandTimeoutKey): number {
  const raw = process.env[TIMEOUT_ENV[key]];
  if (raw === undefined || raw.trim() === "") return TIMEOUT_DEFAULTS_MS[key];
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : TIMEOUT_DEFAULTS_MS[key];
}

export class CommandError extends Error {
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorKind?: "timeout";

  constructor(
    message: string,
    details: {
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      errorKind?: "timeout";
    } = {},
  ) {
    super(message);
    this.name = "CommandError";
    this.exitCode = details.exitCode;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
    this.errorKind = details.errorKind;
  }
}

// Every command gets its own process group, so a timeout can kill what it started too.
// yt-dlp starts ffmpeg, and killing only yt-dlp left ffmpeg running. Where a group cannot
// be made, the spawn falls back to a plain child and the kill falls back to the child.
const liveCommands = new Set<number>();
let exitHookInstalled = false;

function spawnCommand(args: string[], detached: boolean) {
  return Bun.spawn(args, {
    // Passing env makes Bun look the executable up on the PATH as it is now. Without
    // it, Bun uses the PATH from process start, which ignores PATH changes made later.
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached,
  });
}

function spawnInOwnGroup(args: string[]) {
  if (process.platform === "win32") return spawnCommand(args, false);
  try {
    return spawnCommand(args, true);
  } catch {
    // setsid is not allowed here (for example under proot). A missing executable
    // fails again on this second spawn, with the same error.
    return spawnCommand(args, false);
  }
}

// Kills the command's whole group. The group id is the child's pid when the child
// started its own group. If there is no such group, only the child is killed.
function killCommand(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

// Kills every command that is still running, with its group. A detached command does
// not get the terminal's Ctrl-C, so the server and the worker call this before they exit.
export function killAllRunningCommands() {
  for (const pid of liveCommands) killCommand(pid);
  liveCommands.clear();
}

// Resolves with stdout. Rejects on a non-zero exit (with exitCode and stderr) or when
// the time limit passes (with errorKind "timeout").
export async function runCommand(
  args: string[],
  options: { timeoutMs: number; label: string },
): Promise<string> {
  const proc = spawnInOwnGroup(args);
  liveCommands.add(proc.pid);
  proc.exited.then(() => liveCommands.delete(proc.pid));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Backstop for a normal process.exit. A process killed by an unhandled signal does
    // not run exit hooks, so the entry points also call killAllRunningCommands.
    process.on("exit", killAllRunningCommands);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      killCommand(proc.pid);
      resolve("timeout");
    }, options.timeoutMs);
  });
  // Reads are raced against the timer rather than awaited alone. A child that the
  // kill missed (for example one a child spawned) can keep the pipes open.
  const finished = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
  finished.catch(() => {});

  const outcome = await Promise.race([finished, timedOut]);
  clearTimeout(timer);

  if (outcome === "timeout") {
    throw new CommandError(
      `${options.label} timed out after ${options.timeoutMs}ms`,
      { errorKind: "timeout" },
    );
  }
  if (outcome.exitCode !== 0) {
    throw new CommandError(
      `${options.label} exited with code ${outcome.exitCode}: ${outcome.stderr.trim()}`,
      {
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
      },
    );
  }
  return outcome.stdout;
}
