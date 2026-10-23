// One-off: re-download tracks that are not stored as Opus, point the DB at the
// new file, then delete the old one. Dry run unless --apply is passed.
//
//   bun run src/scripts/convert-library-to-opus.ts
//   bun run src/scripts/convert-library-to-opus.ts --apply [--concurrency 2]
//
// Safe to re-run: only rows still pointing at a non-Opus file are selected.
import { access, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { $ } from "bun";
import { and, eq, sql } from "drizzle-orm";
import { db } from "~/server/db";
import { tracks } from "~/server/db/schema";
import { downloadWithRetry, opusFilePath } from "~/utils/fetchAudio";

type Row = { id: string; title: string; youtubeId: string; filePath: string };

// The same recording should have the same length. A bigger gap means YouTube
// served a different cut, so the old file is kept.
const DURATION_TOLERANCE_SECONDS = 1;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const concurrency = Math.min(
  8,
  Math.max(1, Number.parseInt(flagValue("--concurrency") ?? "2", 10) || 2),
);

function flagValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function probe(path: string) {
  const json = JSON.parse(
    await $`ffprobe -v error -show_entries stream=codec_name,codec_type -show_entries format=format_name,duration -of json ${path}`.text(),
  );
  const audio = json.streams?.find(
    (s: { codec_type: string }) => s.codec_type === "audio",
  );
  return {
    codec: audio?.codec_name as string | undefined,
    formatName: String(json.format?.format_name ?? ""),
    duration: Number(json.format?.duration),
  };
}

// Throws unless the file is an Ogg Opus file whose length matches the old file.
async function verifyOpus(path: string, oldPath: string) {
  const info = await probe(path);
  if (info.codec !== "opus")
    throw new Error(`${path}: expected opus, got ${info.codec ?? "no audio"}`);
  if (!info.formatName.split(",").includes("ogg")) {
    throw new Error(`${path}: expected ogg container, got ${info.formatName}`);
  }
  if (!Number.isFinite(info.duration) || info.duration <= 0) {
    throw new Error(`${path}: no usable duration`);
  }
  if (await exists(oldPath)) {
    const oldDuration = Number((await probe(oldPath)).duration);
    if (Math.abs(oldDuration - info.duration) > DURATION_TOLERANCE_SECONDS) {
      throw new Error(
        `${path}: duration ${info.duration.toFixed(2)}s differs from ${oldDuration.toFixed(2)}s in ${oldPath}`,
      );
    }
  }
}

// Returns the other track that already owns the target path, if any.
function targetOwner(row: Row, target: string) {
  const owner = db
    .select({ id: tracks.id })
    .from(tracks)
    .where(eq(tracks.file_path, target))
    .get();
  return owner && owner.id !== row.id ? owner.id : undefined;
}

async function convertTrack(row: Row): Promise<void> {
  const target = opusFilePath(row.filePath);
  if (await exists(target)) {
    // An earlier run wrote the file but stopped before the DB update. Check it
    // instead of downloading it again.
    await verifyOpus(target, row.filePath);
  } else {
    // Download under a hidden name in the same directory, so a half-written file
    // never takes the final name and the final rename stays on one filesystem.
    const temp = join(dirname(target), `.convert-${row.id}.opus`);
    await unlink(temp).catch(() => {}); // yt-dlp skips a download when the file already exists
    await downloadWithRetry(
      `https://www.youtube.com/watch?v=${row.youtubeId}`,
      temp,
      { jobId: `opus-convert:${row.id}`, youtubeId: row.youtubeId },
    );
    try {
      await verifyOpus(temp, row.filePath);
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  // Compare-and-set on the old path, so a row changed by something else is not overwritten.
  const updated = db
    .update(tracks)
    .set({ file_path: target })
    .where(and(eq(tracks.id, row.id), eq(tracks.file_path, row.filePath)))
    .returning({ id: tracks.id })
    .all();
  if (updated.length !== 1) {
    throw new Error(`track ${row.id} changed during conversion, old file kept`);
  }

  // Only after the DB points at the new file.
  await unlink(row.filePath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function main() {
  const rows: Row[] = db
    .select({
      id: tracks.id,
      title: tracks.title,
      youtubeId: tracks.youtube_id,
      filePath: tracks.file_path,
    })
    .from(tracks)
    .where(sql`lower(${tracks.file_path}) not like '%.opus'`)
    .all();

  console.log(
    `${rows.length} track(s) not stored as .opus${apply ? "" : " (dry run, pass --apply to convert)"}`,
  );

  const counts = { converted: 0, skipped: 0, failed: 0 };
  const queue = [...rows];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const target = opusFilePath(row.filePath);
      const label = `${row.title} | ${row.filePath} -> ${target}`;
      const owner = targetOwner(row, target);
      if (owner) {
        counts.skipped++;
        console.log(`SKIP, ${target} belongs to track ${owner}: ${label}`);
        continue;
      }
      if (!apply) {
        counts.converted++;
        console.log(`would convert: ${label}`);
        continue;
      }
      try {
        await convertTrack(row);
        counts.converted++;
        console.log(`converted: ${label}`);
      } catch (error) {
        counts.failed++;
        console.error(
          `failed: ${label}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const label = apply ? "converted" : "would convert";
  console.log(
    `${label} ${counts.converted}, skipped ${counts.skipped}, failed ${counts.failed}`,
  );
  process.exitCode = counts.failed > 0 ? 1 : 0;
}

if (import.meta.main) await main();
