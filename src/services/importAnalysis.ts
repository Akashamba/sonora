import { eq } from "drizzle-orm";
import { db } from "~/server/db";
import { tracks } from "~/server/db/schema";
import {
  type AlbumCandidate,
  albumArtistFromEntries,
  albumNeedsConfirmation,
  albumSearchTermsFromPlaylist,
  collapseAlbumCandidates,
  detectPlaylistKind,
  fetchMusicBrainzRelease,
  fetchMusicBrainzReleases,
  parseYouTubeUrl,
  scoreAlbumCandidates,
} from "~/utils/metadata-utils";
import {
  logExternalCall,
  logIngestFailure,
  logIngestSuccess,
  logIngestWarning,
} from "~/utils/ingestLogger";
import { CommandError, commandTimeoutMs, runCommand } from "~/utils/runCommand";

export type ImportRecommendation =
  | { mode: "single" }
  | { mode: "playlist" }
  | { mode: "album"; releaseId: string | null };

// The `data` object of POST /import/preview (see notes/late-night/contract.md).
export type ImportPreview = {
  url: string;
  kind: "single" | "album" | "playlist";
  title: string | null;
  uploader: string | null;
  entryCount: number;
  entries: {
    position: number;
    youtubeId: string;
    title: string;
    durationMs: number | null;
    inLibrary: boolean;
  }[];
  albumCandidates: AlbumCandidate[];
  recommendation: ImportRecommendation;
  needsConfirmation: boolean;
};

export type ImportAnalysis = {
  data: ImportPreview;
  // Job URL for each entry, in the same order as `data.entries`.
  entryUrls: string[];
};

const IMPORT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export class InvalidImportUrlError extends Error {}

// Checks an import URL before anything fetches it. Only YouTube hosts pass. Playlist URLs
// are rebuilt from the list id, and single-video URLs lose their userinfo, port and hash,
// so yt-dlp only ever gets a clean URL on a YouTube host.
export function normalizeImportUrl(input: string): {
  url: string;
  isPlaylist: boolean;
} {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new InvalidImportUrlError("url could not be parsed");
  }
  if (!IMPORT_HOSTS.has(parsed.hostname))
    throw new InvalidImportUrlError("url must be a YouTube URL");

  const list = parsed.searchParams.get("list");
  if (list === null)
    return {
      url: `https://${parsed.hostname}${parsed.pathname}${parsed.search}`,
      isPlaylist: false,
    };
  if (!/^[A-Za-z0-9_-]+$/.test(list))
    throw new InvalidImportUrlError("playlist id is not valid");
  // music.youtube.com carries the album metadata yt-dlp reads for OLAK5uy_ playlists.
  const host =
    parsed.hostname === "music.youtube.com"
      ? "music.youtube.com"
      : "www.youtube.com";
  return { url: `https://${host}/playlist?list=${list}`, isPlaylist: true };
}

function isInLibrary(youtubeId: string) {
  return Boolean(
    db
      .select({ id: tracks.id })
      .from(tracks)
      .where(eq(tracks.youtube_id, youtubeId))
      .get(),
  );
}

// The title and duration of one video, from a single yt-dlp call. A failure is logged
// and leaves both empty, so the preview still answers and the URL can still be submitted.
async function singleVideoInfo(
  url: string,
  youtubeId: string,
  requestId?: string,
): Promise<{ title: string | null; durationMs: number | null }> {
  try {
    const raw = await logExternalCall(
      { service: "yt_dlp_preview", requestId },
      () =>
        runCommand(
          [
            "yt-dlp",
            "--dump-json",
            "--skip-download",
            "--no-playlist",
            "--",
            url,
          ],
          {
            timeoutMs: commandTimeoutMs("ytDlpMetadata"),
            label: "yt-dlp preview",
          },
        ),
    );
    const info = JSON.parse(raw);
    return {
      title: typeof info.title === "string" && info.title ? info.title : null,
      durationMs: Number.isFinite(info.duration)
        ? Math.round(info.duration * 1000)
        : null,
    };
  } catch (error) {
    // A stalled yt-dlp is not a missing title: the preview answers 504 instead.
    if (error instanceof CommandError && error.errorKind === "timeout")
      throw error;
    await logIngestWarning("import_preview_single_failed", error, {
      requestId,
      youtubeId,
    });
    return { title: null, durationMs: null };
  }
}

// Inspects a URL without creating jobs. Preview and POST /import both call this, so
// both see the same entries, album candidates and recommendation.
export async function analyzeImportUrl(
  input: string,
  requestId?: string,
): Promise<ImportAnalysis> {
  const { url, isPlaylist } = normalizeImportUrl(input);
  if (!isPlaylist) {
    let youtubeId: string;
    try {
      youtubeId = parseYouTubeUrl(url)[0];
    } catch (error) {
      throw new InvalidImportUrlError((error as Error).message);
    }
    const video = await singleVideoInfo(url, youtubeId, requestId);
    return {
      data: {
        url,
        kind: "single",
        title: video.title,
        uploader: null,
        entryCount: 1,
        entries: [
          {
            position: 0,
            youtubeId,
            title: video.title ?? "",
            durationMs: video.durationMs,
            inLibrary: isInLibrary(youtubeId),
          },
        ],
        albumCandidates: [],
        recommendation: { mode: "single" },
        needsConfirmation: false,
      },
      entryUrls: [url],
    };
  }

  const raw = await logExternalCall(
    { service: "yt_dlp_playlist", requestId },
    () =>
      runCommand(["yt-dlp", "--flat-playlist", "-J", "--", url], {
        timeoutMs: commandTimeoutMs("ytDlpPlaylist"),
        label: "yt-dlp playlist preview",
      }),
  );
  const playlist = JSON.parse(raw);
  const videos = (playlist.entries ?? []).filter((item: any) => item?.id);
  const entries = videos.map((item: any, position: number) => ({
    position,
    youtubeId: item.id,
    title: item.title ?? "",
    durationMs: Number.isFinite(item.duration)
      ? Math.round(item.duration * 1000)
      : null,
    inLibrary: isInLibrary(item.id),
  }));
  const entryUrls: string[] = videos.map(
    (item: any) => item.url ?? `https://www.youtube.com/watch?v=${item.id}`,
  );
  logIngestSuccess("import_playlist_expanded", {
    requestId,
    isPlaylist: true,
    urlCount: entryUrls.length,
  });

  const title = playlist.title ?? null;
  const uploader = playlist.uploader ?? playlist.channel ?? null;
  let albumCandidates: AlbumCandidate[] = [];
  if (title) {
    const search = albumSearchTermsFromPlaylist(title, uploader);
    // YouTube Music album playlists (OLAK5uy_) often have no uploader, so take the
    // artist from the entries.
    const artist =
      search.artist ??
      (playlist.id?.startsWith("OLAK5uy_")
        ? albumArtistFromEntries(playlist.entries ?? [])
        : null);
    try {
      const response = await fetchMusicBrainzReleases(
        `release:${JSON.stringify(search.album)}${artist ? ` AND artist:${JSON.stringify(artist)}` : ""}`,
        { jobId: requestId },
      );
      albumCandidates = scoreAlbumCandidates(
        response.releases ?? [],
        search.album,
        artist ?? "",
        entries.length,
      );
    } catch (error) {
      await logIngestFailure("import_preview_musicbrainz_failed", error, {
        requestId,
        stage: "preview_album_search",
      });
    }
  }

  const hasReleaseMatch = (albumCandidates[0]?.score ?? 0) >= 0.65;
  const kind = detectPlaylistKind(playlist.id, hasReleaseMatch);
  return {
    data: {
      url,
      kind,
      title,
      uploader,
      entryCount: entries.length,
      entries,
      albumCandidates:
        kind === "album" ? collapseAlbumCandidates(albumCandidates) : [],
      recommendation:
        kind === "album"
          ? { mode: "album", releaseId: albumCandidates[0]?.releaseId ?? null }
          : { mode: "playlist" },
      needsConfirmation:
        kind === "album" &&
        albumNeedsConfirmation(albumCandidates, entries.length),
    },
    entryUrls,
  };
}

// The release group of the chosen release. Taken from the analysis candidates when
// possible, otherwise fetched. A failed fetch is logged and stored as null.
export async function releaseGroupIdForRelease(
  releaseId: string,
  candidates: AlbumCandidate[],
  requestId?: string,
): Promise<string | null> {
  const candidate = candidates.find((item) => item.releaseId === releaseId);
  if (candidate?.releaseGroupId) return candidate.releaseGroupId;
  try {
    const release = await fetchMusicBrainzRelease(releaseId, {
      jobId: requestId,
    });
    return release["release-group"]?.id ?? null;
  } catch (error) {
    await logIngestWarning("import_release_group_lookup_failed", error, {
      requestId,
      releaseId,
    });
    return null;
  }
}
