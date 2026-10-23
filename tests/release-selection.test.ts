import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import-time code may open the DB, so point it at a temp file.
process.env.DB_FILE_NAME = join(await mkdtemp(join(tmpdir(), "sonora-release-db-")), "test.sqlite");
const { findFirstCompleteRelease } = await import("../src/utils/metadata-utils");

function release(overrides: Record<string, unknown> = {}) {
  return { date: "2020-05-01", "release-group": { id: "rg-1", "primary-type": "Album", title: "Album" }, ...overrides };
}
function messageFor(recording: unknown) {
  try {
    findFirstCompleteRelease(recording);
    return null;
  } catch (error: any) {
    return error.message as string;
  }
}

describe("findFirstCompleteRelease", () => {
  test("returns the first release with every required field", () => {
    const first = release({ date: undefined });
    const second = release({ id: "second" });
    expect(findFirstCompleteRelease({ releases: [first, second] })).toBe(second);
  });

  test("names only the field that is actually missing", () => {
    expect(messageFor({ releases: [release({ date: undefined })] })).toBe(
      "No complete release found in 1 release: missing date (1 release)",
    );
  });

  test("groups releases by the fields they lack", () => {
    const noDate = release({ date: null });
    const noGroupTitle = release({ "release-group": { id: "rg-2", "primary-type": "EP" } });
    expect(messageFor({ releases: [noDate, noDate, noGroupTitle] })).toBe(
      "No complete release found in 3 releases: missing date (2 releases); missing release-group.title (1 release)",
    );
  });

  test("says so when the recording has no releases", () => {
    expect(messageFor({ releases: [] })).toBe("No complete release found: the recording has no releases");
    expect(messageFor({})).toBe("No complete release found: the recording has no releases");
  });
});
