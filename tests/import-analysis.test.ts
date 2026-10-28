import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  DELUXE,
  OLAK_ID,
  OLAK_URL,
  OTHER_ID,
  OTHER_URL,
  PRESSING_A,
  SINGLE_ID,
  SINGLE_URL,
  fakeYtDlpScript,
  playlistJson,
  singleVideoJson,
  stubFileContents,
} from "./fixtures/import-analysis-fixtures";

let tempDir: string;
const originalPath = process.env.PATH;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-import-analysis-"));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  process.env.PATH = originalPath;
});

// Runs analyzeImportUrl for each URL in a child process with its own DB, a fake yt-dlp on
// PATH and the MusicBrainz stub preloaded. Returns one result, or an error message, per URL.
async function analyzeInChild(urls: string[]) {
  const bin = join(tempDir, "bin");
  await mkdir(bin, { recursive: true });
  const olakFile = join(tempDir, "olak.json");
  const otherFile = join(tempDir, "other.json");
  const singleFile = join(tempDir, "single.json");
  await writeFile(
    singleFile,
    JSON.stringify(singleVideoJson(SINGLE_ID, "Single Video Title", 213)),
  );
  await writeFile(
    olakFile,
    JSON.stringify(playlistJson(OLAK_ID, "GUTS", null, 12)),
  );
  await writeFile(
    otherFile,
    JSON.stringify(playlistJson(OTHER_ID, "Road Trip Mix", "Someone", 5)),
  );
  await writeFile(
    join(bin, "yt-dlp"),
    fakeYtDlpScript(tempDir, {
      [OLAK_ID]: olakFile,
      [OTHER_ID]: otherFile,
      [SINGLE_ID]: singleFile,
    }),
  );
  await chmod(join(bin, "yt-dlp"), 0o755);
  const databasePath = join(tempDir, "test.sqlite");
  const setup = new Database(databasePath);
  setup.exec(
    await Bun.file(
      new URL("./fixtures/playlist-schema.sql", import.meta.url),
    ).text(),
  );
  setup.close();
  const stubFile = join(tempDir, "mb.json");
  await writeFile(stubFile, stubFileContents());
  const probe = join(tempDir, "probe.ts");
  await writeFile(
    probe,
    `const { analyzeImportUrl } = await import(${JSON.stringify(join(process.cwd(), "src/services/importAnalysis.ts"))});
const out = [];
for (const url of ${JSON.stringify(urls)}) {
  try { out.push(await analyzeImportUrl(url)); }
  catch (error) { out.push({ error: String(error?.message ?? error) }); }
}
console.log("RESULT " + JSON.stringify(out));
`,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      join(process.cwd(), "tests/fixtures/musicbrainz-stub.ts"),
      probe,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_FILE_NAME: databasePath,
        LOG_DIR: tempDir,
        MB_STUB_FILE: stubFile,
        PATH: `${bin}:${originalPath}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const calls = await readFile(join(tempDir, "yt-dlp-calls.log"), "utf8").catch(
    () => "",
  );
  // Ingest log lines share stdout, so the result is the line with the marker.
  const line = stdout.split("\n").find((text) => text.startsWith("RESULT "));
  return {
    results: JSON.parse(line?.slice("RESULT ".length) ?? "null") as any[],
    calls,
  };
}

describe("analyzeImportUrl", () => {
  test("an OLAK album playlist gives the preview data, and the same answer on every call", async () => {
    // The second call gets the MusicBrainz results in reverse order.
    const { results } = await analyzeInChild([OLAK_URL, OLAK_URL]);
    const [first, second] = results;
    expect(second).toEqual(first);

    const { data, entryUrls } = first;
    expect(Object.keys(data).sort()).toEqual(
      [
        "albumCandidates",
        "entries",
        "entryCount",
        "kind",
        "needsConfirmation",
        "recommendation",
        "title",
        "uploader",
        "url",
      ].sort(),
    );
    expect(data).toMatchObject({
      url: OLAK_URL,
      kind: "album",
      title: "GUTS",
      uploader: null,
      entryCount: 12,
      needsConfirmation: false,
      recommendation: { mode: "album", releaseId: PRESSING_A },
    });
    expect(data.entries).toHaveLength(12);
    expect(data.entries[0]).toEqual({
      position: 0,
      youtubeId: "GUTSTRK000",
      title: "Track 1",
      durationMs: 180000,
      inLibrary: false,
    });
    expect(entryUrls).toHaveLength(12);
    expect(entryUrls[11]).toBe("https://music.youtube.com/watch?v=GUTSTRK011");

    // One edition per release group: the two pressings collapse to the one recommended.
    expect(data.albumCandidates.map((c: any) => c.releaseId)).toEqual([
      PRESSING_A,
      DELUXE,
    ]);
    expect(data.albumCandidates[0]).toMatchObject({
      releaseGroupId: "rg-guts",
      trackCount: 12,
      score: 1,
    });
    expect(data.albumCandidates[1].releaseGroupId).toBe("rg-guts-deluxe");
  });

  test("a playlist with no release match is a playlist with no candidates", async () => {
    const { results } = await analyzeInChild([OTHER_URL]);
    expect(results[0].data).toMatchObject({
      kind: "playlist",
      title: "Road Trip Mix",
      uploader: "Someone",
      entryCount: 5,
      albumCandidates: [],
      recommendation: { mode: "playlist" },
      needsConfirmation: false,
    });
  });

  test("a single video gets its title and duration from one yt-dlp call", async () => {
    const { results, calls } = await analyzeInChild([SINGLE_URL]);
    expect(results[0]).toEqual({
      data: {
        url: SINGLE_URL,
        kind: "single",
        title: "Single Video Title",
        uploader: null,
        entryCount: 1,
        entries: [
          {
            position: 0,
            youtubeId: SINGLE_ID,
            title: "Single Video Title",
            durationMs: 213000,
            inLibrary: false,
          },
        ],
        albumCandidates: [],
        recommendation: { mode: "single" },
        needsConfirmation: false,
      },
      entryUrls: [SINGLE_URL],
    });
    // One call, with --dump-json, and no playlist expansion.
    const lines = calls.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("--dump-json");
    expect(lines[0]).not.toContain("--flat-playlist");
    // The call is logged like the other yt-dlp calls.
    const logFile = (await readdir(tempDir)).find((name) =>
      name.startsWith("ingest-"),
    );
    const logged = (await readFile(join(tempDir, logFile!), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.service === "yt_dlp_preview");
    expect(logged.map((record) => record.outcome)).toEqual(["ok"]);
  });

  test("a single video whose yt-dlp call fails still previews, with no title", async () => {
    const url = "https://www.youtube.com/watch?v=zzzzzzzzzzz";
    const { results } = await analyzeInChild([url]);
    expect(results[0]).toMatchObject({
      data: {
        url,
        kind: "single",
        title: null,
        entries: [{ youtubeId: "zzzzzzzzzzz", title: "", durationMs: null }],
        recommendation: { mode: "single" },
      },
      entryUrls: [url],
    });
  });

  test("a failing yt-dlp call rejects, so the routes can answer with their error", async () => {
    const { results } = await analyzeInChild([
      "https://www.youtube.com/playlist?list=PLunknown",
    ]);
    expect(results[0].error).toEqual(expect.any(String));
  });
});
