import { eq } from "drizzle-orm";
import { mkdir, rename, rm } from "node:fs/promises";
import { db } from "~/server/db";
import { release_groups } from "~/server/db/schema";
import { retryCoverArt } from "~/utils/coverArtRetry";

// Cover art is downloaded from the Cover Art Archive once per release group and size,
// then served from disk. archive.org takes two redirects and often seconds per image.
export type CoverSize = "small" | "large";
export const COVER_SIZES: CoverSize[] = ["small", "large"];

const COVER_DIR = process.env.COVER_PATH ?? "covers";
const DOWNLOAD_TIMEOUT_MS = 15_000;

// Release group ids are UUIDs. Anything else could escape the cover folder.
const SAFE_ID = /^[\w-]+$/;

export const coverFilePath = (releaseGroupId: string, size: CoverSize) =>
  `${COVER_DIR}/${releaseGroupId}-${size}.jpg`;

// The URL the client loads, or null when the release group has no cover art.
export const coverRoute = (
  releaseGroupId: string | null | undefined,
  sourceUrl: string | null | undefined,
  size: CoverSize,
) => (releaseGroupId && sourceUrl ? `/covers/${releaseGroupId}/${size}` : null);

// cached: the file is on disk. Otherwise error is set when the download failed, and
// unset when the release group has no cover to download.
export type CoverResult = { cached: true } | { cached: false; error?: unknown };

// Downloads running now, so two requests for one cover share one download.
const inFlight = new Map<string, Promise<CoverResult>>();

// Makes sure the cover is on disk. Never throws.
export function ensureCover(
  releaseGroupId: string,
  size: CoverSize,
): Promise<CoverResult> {
  if (!SAFE_ID.test(releaseGroupId)) return Promise.resolve({ cached: false });
  const path = coverFilePath(releaseGroupId, size);
  const running = inFlight.get(path);
  if (running) return running;
  const task = downloadCover(releaseGroupId, size, path)
    .then((cached): CoverResult => ({ cached }))
    .catch((error): CoverResult => ({ cached: false, error }))
    .finally(() => inFlight.delete(path));
  inFlight.set(path, task);
  return task;
}

async function downloadCover(
  releaseGroupId: string,
  size: CoverSize,
  path: string,
): Promise<boolean> {
  if (await Bun.file(path).exists()) return true;
  const row = db
    .select({
      original: release_groups.cover_art_url,
      large: release_groups.cover_art_url_thumbnail_large,
      small: release_groups.cover_art_url_thumbnail_small,
    })
    .from(release_groups)
    .where(eq(release_groups.id, releaseGroupId))
    .get();
  if (!row) return false;
  // Fall back to a bigger image when the requested thumbnail was never stored.
  const url =
    size === "small"
      ? (row.small ?? row.large ?? row.original)
      : (row.large ?? row.original);
  if (!url) return false;

  const res = await retryCoverArt(async () => {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    // Throwing with the status lets server errors be retried.
    if (res.status === 429 || res.status >= 500) {
      throw Object.assign(new Error(`cover download failed: ${res.status}`), {
        status: res.status,
      });
    }
    return res;
  });
  // The lookup said this image exists, so anything but an image is a failure to report.
  if (!res.ok) throw new Error(`cover download failed: ${res.status}`);
  const type = res.headers.get("content-type");
  if (!type?.startsWith("image/")) {
    throw new Error(`cover download returned ${type ?? "no content type"}`);
  }
  // Write to a temp file and rename, so a reader never sees a half-written image.
  await mkdir(COVER_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await Bun.write(tmp, res);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return true;
}
