import { describe, expect, test } from "bun:test";
import {
  createClaimForPool,
  type ClaimedJob,
} from "../src/workers/ingestTrack/claimForPool";

const job = (id: string): ClaimedJob => ({
  id,
  url: `https://youtu.be/${id}`,
  claimCount: 1,
  queuedForMs: 0,
});

const silent = {
  logInfo: async () => {},
  logFailure: async () => {},
};

describe("createClaimForPool", () => {
  test("returns [] and logs when the claim itself fails", async () => {
    const failures: string[] = [];
    const claim = createClaimForPool({
      claimJobs: async () => {
        throw new Error("database is locked");
      },
      logInfo: silent.logInfo,
      logFailure: async (event) => {
        failures.push(event);
      },
    });

    expect(await claim(2)).toEqual([]);
    expect(failures).toEqual(["job_claim_failed"]);
  });

  test("still returns claimed jobs when the claim log write rejects", async () => {
    const claimed = [job("a"), job("b")];
    const claim = createClaimForPool({
      claimJobs: async () => claimed,
      logInfo: async () => {
        throw new Error("disk full");
      },
      logFailure: silent.logFailure,
    });

    expect(await claim(2)).toEqual(claimed);
  });

  test("still returns claimed jobs when the log write throws synchronously", async () => {
    const claimed = [job("a")];
    const claim = createClaimForPool({
      claimJobs: async () => claimed,
      logInfo: () => {
        throw new TypeError("cannot serialize");
      },
      logFailure: silent.logFailure,
    });

    expect(await claim(1)).toEqual(claimed);
  });

  test("returns [] when the failure log write also rejects", async () => {
    const claim = createClaimForPool({
      claimJobs: async () => {
        throw new Error("database is locked");
      },
      logInfo: silent.logInfo,
      logFailure: async () => {
        throw new Error("log dir missing");
      },
    });

    expect(await claim(1)).toEqual([]);
  });
});
