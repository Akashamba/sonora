import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logIngestWarning } from "../src/utils/ingestLogger";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-timezone-log-"));
  process.env.LOG_DIR = tempDir;
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  delete process.env.LOG_DIR;
});

describe("ingest log timezone", () => {
  test("names the file by the local date and records the timezone and offset", async () => {
    const before = new Date();
    await logIngestWarning("timezone_probe", new Error("probe"));
    const after = new Date();

    const localDate = before.toLocaleDateString("en-CA");
    const lines = (await readFile(join(tempDir, `ingest-${localDate}.jsonl`), "utf8"))
      .trim()
      .split("\n");
    const record = JSON.parse(lines.at(-1)!);

    expect(record.event).toBe("timezone_probe");
    expect(record.timestamp).toMatch(/Z$/);
    expect(new Date(record.timestamp).getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(new Date(record.timestamp).getTime()).toBeLessThanOrEqual(after.getTime());
    expect(record.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(record.utcOffset).toMatch(/^[+-]\d{2}:\d{2}$/);

    const offsetMinutes = -before.getTimezoneOffset();
    const sign = offsetMinutes < 0 ? "-" : "+";
    const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");
    expect(record.utcOffset).toBe(
      `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(offsetMinutes % 60)}`,
    );
  });
});
