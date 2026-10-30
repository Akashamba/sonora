import { describe, expect, test } from "bun:test";
import { retryCoverArt } from "~/utils/coverArtRetry";

const NO_WAIT = [0, 0, 0, 0, 0];

// What Bun's fetch throws when coverartarchive.org drops the handshake.
const reset = () =>
  Object.assign(new Error("The socket connection was closed unexpectedly."), {
    code: "ECONNRESET",
  });
const httpError = (status: number) =>
  Object.assign(new Error(`request failed: ${status}`), { status });

// Throws the given errors in order, then returns "ok".
function failThen(errors: Error[]) {
  const attempts: number[] = [];
  const request = async (attempt: number) => {
    attempts.push(attempt);
    const error = errors[attempt - 1];
    if (error) throw error;
    return "ok";
  };
  return { attempts, request };
}

describe("retryCoverArt", () => {
  test("retries dropped connections until one succeeds", async () => {
    const { attempts, request } = failThen([reset(), reset(), reset()]);
    expect(await retryCoverArt(request, NO_WAIT)).toBe("ok");
    expect(attempts).toEqual([1, 2, 3, 4]);
  });

  test("retries 5xx and 429 responses", async () => {
    const { attempts, request } = failThen([httpError(503), httpError(429)]);
    expect(await retryCoverArt(request, NO_WAIT)).toBe("ok");
    expect(attempts).toEqual([1, 2, 3]);
  });

  test("does not retry a 404", async () => {
    const { attempts, request } = failThen([httpError(404)]);
    await expect(retryCoverArt(request, NO_WAIT)).rejects.toThrow("404");
    expect(attempts).toEqual([1]);
  });

  test("does not retry a timeout", async () => {
    const timeout = new DOMException(
      "The operation timed out.",
      "TimeoutError",
    );
    const { attempts, request } = failThen([timeout]);
    await expect(retryCoverArt(request, NO_WAIT)).rejects.toThrow("timed out");
    expect(attempts).toEqual([1]);
  });

  test("gives up after one attempt per delay plus the first", async () => {
    const { attempts, request } = failThen(Array.from({ length: 10 }, reset));
    await expect(retryCoverArt(request, NO_WAIT)).rejects.toThrow("socket");
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
