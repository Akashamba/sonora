import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  DELUXE,
  OLAK_ID,
  OLAK_URL,
  PRESSING_A,
  UNLISTED,
  fakeYtDlpScript,
  playlistJson,
  stubFileContents,
} from "./fixtures/import-analysis-fixtures";

let tempDir: string;
let server: Bun.Subprocess | undefined;
let base: string;
let databasePath: string;
const originalPath = process.env.PATH;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sonora-import-route-"));
  const bin = join(tempDir, "bin");
  await mkdir(bin, { recursive: true });
  const playlistFile = join(tempDir, "olak.json");
  await writeFile(
    playlistFile,
    JSON.stringify(playlistJson(OLAK_ID, "GUTS", null, 12)),
  );
  await writeFile(
    join(bin, "yt-dlp"),
    fakeYtDlpScript(tempDir, { [OLAK_ID]: playlistFile }),
  );
  await chmod(join(bin, "yt-dlp"), 0o755);
  const stubFile = join(tempDir, "mb.json");
  await writeFile(stubFile, stubFileContents());

  databasePath = join(tempDir, "test.sqlite");
  const setup = new Database(databasePath);
  setup.exec(
    await Bun.file(
      new URL("./fixtures/playlist-schema.sql", import.meta.url),
    ).text(),
  );
  setup.close();

  // The MusicBrainz stub is preloaded, so preview and import both see the same releases.
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  server = Bun.spawn(
    [
      process.execPath,
      "--preload",
      join(process.cwd(), "tests/fixtures/musicbrainz-stub.ts"),
      "src/server/index.ts",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DB_FILE_NAME: databasePath,
        LOG_DIR: tempDir,
        MB_STUB_FILE: stubFile,
        BIND_HOST: "127.0.0.1",
        BIND_PORT: String(port),
        DEMO_MODE: "false",
        PATH: `${bin}:${originalPath}`,
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(`${base}/`);
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await Bun.sleep(100);
    }
  }
});

afterEach(async () => {
  server?.kill();
  server = undefined;
  await rm(tempDir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function importRow(id: string) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db
      .query(
        "SELECT mode, musicbrainz_release_id, musicbrainz_release_group_id FROM imports WHERE id = ?",
      )
      .get(id) as Record<string, string | null>;
  } finally {
    db.close();
  }
}

describe("preview and POST /import", () => {
  test("auto import picks the release that preview recommends and stores its release group", async () => {
    const preview = await post("/import/preview", { url: OLAK_URL });
    expect(preview.status).toBe(200);
    const { data } = (await preview.json()) as any;
    expect(data.recommendation).toEqual({
      mode: "album",
      releaseId: PRESSING_A,
    });

    const created = await post("/import", { url: OLAK_URL });
    expect(created.status).toBe(200);
    const { importId, jobCount } = ((await created.json()) as any).data;
    expect(jobCount).toBe(12);

    expect(importRow(importId)).toEqual({
      mode: "album",
      musicbrainz_release_id: PRESSING_A,
      musicbrainz_release_group_id: "rg-guts",
    });
  });

  test("a client releaseId takes the release group from the candidates", async () => {
    const created = await post("/import", {
      url: OLAK_URL,
      mode: "album",
      releaseId: DELUXE,
    });
    const { importId } = ((await created.json()) as any).data;
    expect(importRow(importId)).toEqual({
      mode: "album",
      musicbrainz_release_id: DELUXE,
      musicbrainz_release_group_id: "rg-guts-deluxe",
    });
  });

  test("a releaseId that is not among the candidates is fetched for its release group", async () => {
    const created = await post("/import", {
      url: OLAK_URL,
      mode: "album",
      releaseId: UNLISTED,
    });
    const { importId } = ((await created.json()) as any).data;
    expect(importRow(importId)).toEqual({
      mode: "album",
      musicbrainz_release_id: UNLISTED,
      musicbrainz_release_group_id: "rg-other",
    });
  });

  test("a playlist import stores no release", async () => {
    const created = await post("/import", { url: OLAK_URL, mode: "playlist" });
    const { importId } = ((await created.json()) as any).data;
    expect(importRow(importId)).toEqual({
      mode: "playlist",
      musicbrainz_release_id: null,
      musicbrainz_release_group_id: null,
    });
  });
});
