import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

let tempDir: string;
let databasePath: string;
let coverDir: string;

const schemaSql = () =>
  Bun.file(new URL("./fixtures/playlist-schema.sql", import.meta.url)).text();

// Runs ensureCover in a child process with its own DB_FILE_NAME and COVER_PATH, so
// it never touches the real database or covers folder. `fetchBody` replaces fetch.
async function ensureCoverInProbe(releaseGroupId: string, fetchBody: string) {
  const probe = join(tempDir, `probe-${crypto.randomUUID()}.ts`);
  await writeFile(
    probe,
    `let calls = 0;
globalThis.fetch = (async () => { calls++; ${fetchBody} }) as unknown as typeof fetch;
const { ensureCover } = await import(${JSON.stringify(join(process.cwd(), "src/utils/coverCache.ts"))});
const { errorKindFields } = await import(${JSON.stringify(join(process.cwd(), "src/utils/networkErrors.ts"))});
const result = await ensureCover(${JSON.stringify(releaseGroupId)}, "small");
console.log("RESULT " + JSON.stringify({
  cached: result.cached,
  error: result.error ? String(result.error.message) : undefined,
  ...errorKindFields(result.error),
  calls,
}));
`,
  );
  const child = Bun.spawn(["bun", probe], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_FILE_NAME: databasePath,
      COVER_PATH: coverDir,
      LOG_DIR: tempDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const line = stdout.split("\n").find((text) => text.startsWith("RESULT "));
  return JSON.parse(line!.slice("RESULT ".length));
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-cover-cache-"));
  databasePath = join(tempDir, "test.sqlite");
  coverDir = join(tempDir, "covers");
  const setup = new Database(databasePath);
  setup.exec(await schemaSql());
  const now = Date.now();
  const insert = `INSERT INTO release_groups_table (id, musicbrainz_primary_type, title, first_release_date, cover_art_url_thumbnail_small, created_at, updated_at) VALUES (?, 'Album', 'Album', 0, ?, ?, ?)`;
  setup.run(insert, ["rg-cover", "https://caa.test/small.jpg", now, now]);
  setup.run(insert, ["rg-none", null, now, now]);
  setup.close();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const image = `return new Response("jpeg", { headers: { "content-type": "image/jpeg" } });`;

describe("ensureCover", () => {
  test("downloads the cover to the covers folder", async () => {
    const result = await ensureCoverInProbe("rg-cover", image);
    expect(result).toEqual({ cached: true, calls: 1 });
    expect(await readdir(coverDir)).toEqual(["rg-cover-small.jpg"]);
  });

  test("retries dropped connections, then caches", async () => {
    const result = await ensureCoverInProbe(
      "rg-cover",
      `if (calls < 3) throw Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" }); ${image}`,
    );
    expect(result).toEqual({ cached: true, calls: 3 });
  });

  test("reports the error when every attempt is dropped", async () => {
    const result = await ensureCoverInProbe(
      "rg-cover",
      `throw Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" });`,
    );
    // preload.ts sets five retry waits, so six attempts.
    expect(result).toMatchObject({
      cached: false,
      errorKind: "connection_reset",
      calls: 6,
    });
  });

  test("reports a 404 for an image the lookup said exists", async () => {
    const result = await ensureCoverInProbe(
      "rg-cover",
      `return new Response("missing", { status: 404 });`,
    );
    expect(result).toEqual({
      cached: false,
      error: "cover download failed: 404",
      calls: 1,
    });
  });

  test("reports no error when the release group has no cover", async () => {
    const result = await ensureCoverInProbe("rg-none", image);
    expect(result).toEqual({ cached: false, calls: 0 });
  });
});
