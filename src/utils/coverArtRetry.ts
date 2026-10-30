import { classifyNetworkError } from "~/utils/networkErrors";

// Wait before each retry. On 2026-10-29 coverartarchive.org dropped a third to half of
// TLS handshakes from this machine. Spacing requests out did not change that rate, so
// the number of attempts matters more than the length of the waits. 10 attempts in all.
const DEFAULT_RETRY_DELAYS_MS = [
  200, 500, 1000, 2000, 2000, 2000, 2000, 2000, 2000,
];

// Read at call time so tests can shorten the waits. A comma-separated list of milliseconds.
function retryDelaysMs(): number[] {
  const raw = process.env.COVER_ART_RETRY_DELAYS_MS;
  if (!raw) return DEFAULT_RETRY_DELAYS_MS;
  const parsed = raw.split(",").map(Number);
  return parsed.every((n) => Number.isFinite(n) && n >= 0)
    ? parsed
    : DEFAULT_RETRY_DELAYS_MS;
}

// Dropped connections and server errors. Not timeouts: each attempt already waits the
// full fetch timeout, and a 404 means there is no cover to find.
function isRetryable(error: unknown): boolean {
  const kind = classifyNetworkError(error);
  return (
    kind === "connection_reset" ||
    kind === "unreachable" ||
    kind === "dns" ||
    kind === "http_429" ||
    kind === "http_5xx"
  );
}

// Runs one Cover Art Archive request, retrying transient failures. The attempt
// number starts at 1.
export async function retryCoverArt<T>(
  request: (attempt: number) => Promise<T>,
  delaysMs: readonly number[] = retryDelaysMs(),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request(attempt);
    } catch (error) {
      const delay = delaysMs[attempt - 1];
      if (delay === undefined || !isRetryable(error)) throw error;
      await Bun.sleep(delay);
    }
  }
}
