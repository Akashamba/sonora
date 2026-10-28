import { commandTimeoutMs, runCommand } from "~/utils/runCommand";
import {
  type ExternalCallRecord,
  logExternalCall,
  logIngestInfo,
  logIngestSuccess,
  logIngestWarning,
  writeLogArtifact,
} from "~/utils/ingestLogger";
import { errorKindFields } from "~/utils/networkErrors";
import { parseJson } from "~/utils/jsonErrors";
import { describeDateValue } from "~/utils/dateLogging";

type IngestLogContext = {
  jobId: string;
  youtubeId: string;
};

// One MusicBrainz lookup, linked to its saved raw response file.
type MusicBrainzLogContext = Partial<IngestLogContext> & {
  musicbrainzLookupId?: string;
  musicbrainzResponseFile?: string;
};

const DEFAULT_EXTERNAL_FETCH_TIMEOUT_MS = 30000;
const MAX_ERROR_BODY_BYTES = 256 * 1024;

// Thrown for failed HTTP responses and for fetch-level failures (no response).
export class ExternalRequestError extends Error {
  readonly service: string;
  readonly host: string;
  readonly url: string;
  readonly status?: number;
  readonly code?: string | number;

  constructor(
    message: string,
    details: {
      service: string;
      host: string;
      url: string;
      status?: number;
      code?: string | number;
      cause?: unknown;
    },
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "ExternalRequestError";
    this.service = details.service;
    this.host = details.host;
    this.url = details.url;
    if (details.status !== undefined) this.status = details.status;
    if (details.code !== undefined) this.code = details.code;
  }
}

// Read at call time so the env value can change without a restart.
function externalFetchTimeoutMs(): number {
  const parsed = Number(process.env.EXTERNAL_FETCH_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_EXTERNAL_FETCH_TIMEOUT_MS;
}

const REQUEST_FAILED_PREFIX = {
  musicbrainz: "Request failed",
  cover_art: "Cover Art Archive request failed",
} as const;

async function fetchExternal(
  service: keyof typeof REQUEST_FAILED_PREFIX,
  host: string,
  url: string,
  record: ExternalCallRecord,
  // Runs before the HTTP error is thrown. Must not throw.
  onErrorResponse?: (res: Response) => Promise<void>,
): Promise<Response> {
  const prefix = REQUEST_FAILED_PREFIX[service];

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "sonora/0.1 (https://github.com/akashamba/sonora)",
      },
      signal: AbortSignal.timeout(externalFetchTimeoutMs()),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown } | null)?.code;
    throw new ExternalRequestError(`${prefix}: ${message}`, {
      service,
      host,
      url,
      code:
        typeof code === "string" || typeof code === "number" ? code : undefined,
      cause: error,
    });
  }

  record.status = res.status;
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter !== null) record.retryAfter = retryAfter;
  if (!res.ok) {
    await onErrorResponse?.(res);
    throw new ExternalRequestError(`${prefix}: ${res.status}`, {
      service,
      host,
      url,
      status: res.status,
    });
  }

  return res;
}

type ParsedYTMetadata = {
  artists: string[];
  track: string | null;
  album: string | null;
  upload_date: string | null;
  durationMs?: number | null;
  // structured: yt-dlp track and artist were used as-is.
  // title_split: artist or track was missing, so the video title was split.
  parsePath: "structured" | "title_split";
};

export async function getAllUrlsFromPlaylist(
  url: string,
  requestId?: string,
): Promise<string[]> {
  // if it's not a playlist, just return it
  if (!url.includes("list=")) {
    logIngestSuccess("import_url_expanded", {
      requestId,
      isPlaylist: false,
      urlCount: 1,
    });
    return [url];
  }

  const output = await logExternalCall(
    { service: "yt_dlp_playlist", requestId },
    () =>
      runCommand(
        ["yt-dlp", "--flat-playlist", "--print", "%(url)s", "--", url],
        {
          timeoutMs: commandTimeoutMs("ytDlpPlaylist"),
          label: "yt-dlp playlist",
        },
      ),
  );

  const urls = output.trim().split("\n").filter(Boolean);
  logIngestSuccess("import_playlist_expanded", {
    requestId,
    isPlaylist: true,
    urlCount: urls.length,
  });
  return urls;
}

/* Parse YouTube urls of different forms to extract standard url and video id */
export function parseYouTubeUrl(
  input: string,
): [youtubeId: string, youtubeUrl: string] {
  if (!input || typeof input !== "string") {
    throw new Error("Invalid input: expected a non-empty string URL.");
  }

  let url;
  try {
    // Normalize: add https:// if the URL has no protocol
    const raw = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: "${input}" could not be parsed.`);
  }

  const { hostname, pathname, searchParams } = url;

  const isYouTubeHost = /^(www\.|m\.|music\.)?youtube(-nocookie)?\.com$/.test(
    hostname,
  );
  const isShortHost = hostname === "youtu.be";

  if (!isYouTubeHost && !isShortHost) {
    throw new Error(
      `Not a YouTube URL: hostname "${hostname}" is not recognized as YouTube.`,
    );
  }

  let videoId = null;

  if (isShortHost) {
    // https://youtu.be/VIDEO_ID  (standard short link)
    // https://youtu.be/watch?v=VIDEO_ID  (malformed short link — seen in the wild)
    if (pathname === "/watch") {
      videoId = searchParams.get("v");
    } else {
      // pathname is "/VIDEO_ID"
      videoId = pathname.slice(1).split("/")[0];
    }
  } else {
    // Full youtube.com / youtube-nocookie.com domain
    const pathSegments = pathname.split("/").filter(Boolean);

    if (pathname === "/watch") {
      // https://www.youtube.com/watch?v=VIDEO_ID
      videoId = searchParams.get("v");
    } else if (pathSegments[0] === "embed" && pathSegments[1]) {
      // https://www.youtube.com/embed/VIDEO_ID
      videoId = pathSegments[1];
    } else if (pathSegments[0] === "shorts" && pathSegments[1]) {
      // https://www.youtube.com/shorts/VIDEO_ID
      videoId = pathSegments[1];
    } else if (pathSegments[0] === "live" && pathSegments[1]) {
      // https://www.youtube.com/live/VIDEO_ID
      videoId = pathSegments[1];
    } else if (pathSegments[0] === "v" && pathSegments[1]) {
      // https://www.youtube.com/v/VIDEO_ID  (old embed format)
      videoId = pathSegments[1];
    }
  }

  // Strip any extra junk that may have crept into the ID (e.g. query strings
  // embedded in the path segment before URL parsing cleaned them up).
  if (videoId) {
    videoId = videoId?.split("?")[0]?.split("&")[0]?.split("#")[0] ?? null;
  }

  // YouTube video IDs are exactly 11 characters of [A-Za-z0-9_-]
  const VALID_ID = /^[A-Za-z0-9_-]{11}$/;
  if (!videoId || !VALID_ID.test(videoId)) {
    throw new Error(
      `Could not extract a valid YouTube video ID from: "${input}"`,
    );
  }

  return [videoId!, `https://www.youtube.com/watch?v=${videoId!}`];
}

/* YT METADATA */
export async function fetchYtMetadata(
  url: string,
  context: Partial<IngestLogContext> = {},
) {
  const metadata = await logExternalCall(
    { service: "yt_dlp_metadata", ...context },
    async () =>
      parseJson(
        await runCommand(["yt-dlp", "--dump-json", "--", url], {
          timeoutMs: commandTimeoutMs("ytDlpMetadata"),
          label: "yt-dlp metadata",
        }),
        "yt-dlp --dump-json",
      ),
  );
  const parsed = parseYtDlpMetadata(metadata);
  await logIngestInfo("yt_metadata_parsed", {
    ...context,
    parsePath: parsed.parsePath,
    rawTitle: metadata.title ?? null,
    rawTrack: metadata.track ?? null,
    rawArtist: metadata.artist ?? null,
    parsedTrack: parsed.track,
    parsedArtists: parsed.artists,
  });
  return parsed;
}

export function parseYtDlpMetadata(
  parsedMetadata: Record<string, any>,
): ParsedYTMetadata {
  const noiseRegex =
    /\((official.*?|lyrics?|audio|video|visualizer|hd|4k|remaster(ed)?|live.*?)\)|\[(official.*?|lyrics?|audio|video|hd.*?)\]/gi;

  const clean = (s: string) =>
    s
      .replace(noiseRegex, "")
      .replace(/\s{2,}/g, " ")
      .trim();

  const formatUploadDate = (d?: string | null) => {
    if (!d || !/^\d{8}$/.test(d)) return null;
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  };

  // Prefer yt-dlp structured metadata
  let track: string | null = parsedMetadata.track ?? null;
  let album: string | null = parsedMetadata.album ?? null;
  let artists: string[] = [];
  let parsePath: ParsedYTMetadata["parsePath"] = "structured";
  const upload_date = formatUploadDate(parsedMetadata.upload_date);

  if (parsedMetadata.artist) {
    artists = splitArtists(parsedMetadata.artist);
  }

  // Fallback to parsing title
  if (!track || artists.length === 0) {
    parsePath = "title_split";
    const title = clean(parsedMetadata.title ?? "");

    if (title.length === 0) {
      throw new Error("No clean title in video");
    }

    const parts = title.split(/\s+-\s+/);

    if (parts.length === 0) {
      throw new Error("unable to split video title");
    }

    if (parts.length >= 2) {
      if (artists.length === 0) {
        artists = splitArtists(parts[0]!);
      }

      if (!track) {
        track = clean(parts.slice(1).join(" - "));
      }
    } else if (!track) {
      track = title;
    }
  }

  return {
    artists,
    track: track ? clean(track) : null,
    album: album ? clean(album) : null,
    upload_date,
    durationMs: Number.isFinite(parsedMetadata.duration)
      ? Math.round(parsedMetadata.duration * 1000)
      : null,
    parsePath,
  };
}

function splitArtists(input: string): string[] {
  return input
    .split(/\s*,\s*|\s+(?:&|x|feat\.?|ft\.?|with|and)\s+/i)
    .map((a) => a.trim())
    .filter(Boolean);
}

/* MUSICBRAINZ METADATA */
// TODO: standardize return type for musicbrainz metadata
// Path of a lookup's raw MusicBrainz response, relative to LOG_DIR.
export function musicbrainzResponseFileFor(musicbrainzLookupId: string) {
  return `musicbrainz/${musicbrainzLookupId}.json`;
}

// Records which MusicBrainz recording was picked. The first recording is taken
// without a score check; this only makes the pick visible in the file.
export async function logMusicBrainzMatchSelected(
  musicbrainzmetadata: any,
  context: Record<string, unknown>,
) {
  const recording = musicbrainzmetadata?.recordings?.[0];
  await logIngestInfo("musicbrainz_match_selected", {
    ...context,
    candidateCount: musicbrainzmetadata?.recordings?.length ?? 0,
    totalCount: musicbrainzmetadata?.count ?? null,
    selectedRecordingId: recording?.id ?? null,
    selectedTitle: recording?.title ?? null,
    score: recording?.matchScore ?? recording?.score ?? null,
    artistCredit:
      recording?.["artist-credit"]?.map(
        (credit: { name: string }) => credit.name,
      ) ?? [],
  });
}

// Keeps the raw body so a bad match can be checked against what MusicBrainz
// returned. Saved before parsing, so a body that fails to parse is still kept.
// A failed save is logged and does not change the lookup's outcome. The path is
// only logged once the write has succeeded.
async function saveMusicBrainzResponse(
  lookup: MusicBrainzLogContext & { musicbrainzLookupId: string },
  body: string,
) {
  try {
    await writeLogArtifact(
      musicbrainzResponseFileFor(lookup.musicbrainzLookupId),
      body,
    );
  } catch (error) {
    await logIngestWarning("musicbrainz_response_save_failed", error, {
      ...lookup,
    });
  }
}

// Reads at most `limit` bytes so a large error page is not held in memory.
// `truncated` is true only when unread bytes were left behind.
async function readCappedBody(res: Response, limit: number) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = limit - bytes;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      bytes += room;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  return {
    text: Buffer.concat(chunks).toString("utf8"),
    bytes,
    truncated,
  };
}

// Keeps the body of a failed MusicBrainz response (e.g. a 503 from rate
// limiting), which can be HTML or JSON. Returns the fields for the failure
// record, or nothing if no artifact was written. Never throws, so the HTTP
// error that is thrown afterwards is unchanged.
async function saveMusicBrainzErrorResponse(
  lookup: MusicBrainzLogContext & { musicbrainzLookupId: string },
  res: Response,
): Promise<Record<string, unknown>> {
  const errorResponseFile = `musicbrainz/${lookup.musicbrainzLookupId}.error.txt`;
  try {
    const body = await readCappedBody(res, MAX_ERROR_BODY_BYTES);
    await writeLogArtifact(errorResponseFile, body.text);
    return {
      errorResponseFile,
      errorResponseBytes: body.bytes,
      errorResponseTruncated: body.truncated,
    };
  } catch (error) {
    await logIngestWarning("musicbrainz_error_response_save_failed", error, {
      ...lookup,
      status: res.status,
    });
    return {};
  }
}

// MusicBrainz asks clients for at most one request per second. Each caller
// reserves its slot before sending, so concurrent ingests queue behind each other.
const DEFAULT_MUSICBRAINZ_MIN_INTERVAL_MS = 1500;
let musicBrainzNextSlotAt = 0;

// Read at call time so tests can turn pacing off.
function musicBrainzMinIntervalMs(): number {
  const configured = process.env.MUSICBRAINZ_MIN_INTERVAL_MS;
  if (configured === undefined) return DEFAULT_MUSICBRAINZ_MIN_INTERVAL_MS;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_MUSICBRAINZ_MIN_INTERVAL_MS;
}

async function waitForMusicBrainzSlot() {
  const now = Date.now();
  const slotAt = Math.max(now, musicBrainzNextSlotAt);
  musicBrainzNextSlotAt = slotAt + musicBrainzMinIntervalMs();
  if (slotAt > now) await Bun.sleep(slotAt - now);
}

// Only transient failures are retried: busy or rate limited responses, timeouts,
// and other 5xx responses. Other failures fail on the first attempt.
const MUSICBRAINZ_MAX_ATTEMPTS = 4;
const DEFAULT_MUSICBRAINZ_BACKOFF_BASE_MS = 2000;
const MUSICBRAINZ_BACKOFF_CAP_MS = 30000;

// Read at call time so tests can shorten the base delay.
function musicBrainzBackoffMs(attempt: number): number {
  const base =
    Number(process.env.MUSICBRAINZ_BACKOFF_BASE_MS) ||
    DEFAULT_MUSICBRAINZ_BACKOFF_BASE_MS;
  const exponential = Math.min(
    MUSICBRAINZ_BACKOFF_CAP_MS,
    base * 2 ** (attempt - 1),
  );
  return exponential + Math.random() * 500;
}

function isRetryableMusicBrainzError(error: unknown): boolean {
  const { errorKind } = errorKindFields(error);
  return (
    errorKind === "timeout" ||
    errorKind === "http_429" ||
    errorKind === "http_5xx"
  );
}

type MusicBrainzSearchInput = {
  artists: string[];
  album: string | null;
  track: string | null;
  durationMs?: number | null;
};

// Feature credits and "with" notes in a title, e.g. "(feat. X)" or "[with X]".
const FEATURE_NOTE_REGEX =
  /\s*[([][^)\]]*\b(?:feat|ft|featuring|with)\b[^)\]]*[)\]]/gi;

function cleanTitleForSearch(title: string) {
  return title
    .replace(FEATURE_NOTE_REGEX, "")
    .replace(/\s*[-–]\s*remaster(?:ed)?(?:\s*\d{4})?\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Keeps letters and digits only, so case, accents, punctuation and "$" for "s" do not block a match.
function normalizeForMatch(value: string) {
  return value
    .replace(/\$/g, "s")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// Wraps a value in a Lucene phrase, so spaces and symbols are matched literally.
function luceneQuote(value: string) {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

// Searches the recording title and main artist, and the release title when asked.
function buildRecordingQuery(
  metadata: MusicBrainzSearchInput,
  includeRelease: boolean,
) {
  const parts: string[] = [];
  const title = cleanTitleForSearch(metadata.track ?? "");
  if (title) parts.push(`recording:${luceneQuote(title)}`);
  if (
    includeRelease &&
    metadata.album &&
    normalizeForMatch(metadata.album) !== normalizeForMatch(title)
  ) {
    parts.push(`release:${luceneQuote(metadata.album)}`);
  }
  if (metadata.artists[0])
    parts.push(`artist:${luceneQuote(metadata.artists[0])}`);
  return parts.join(" AND ");
}

// Keeps recordings whose title matches the video track and that credit one of the
// video's artists. Without this, the top result is used even when it is another song.
function keepMatchingRecordings(
  recordings: any[],
  metadata: MusicBrainzSearchInput,
) {
  const wantedTitle = normalizeForMatch(
    cleanTitleForSearch(metadata.track ?? ""),
  );
  const wantedArtists = new Set(metadata.artists.map(normalizeForMatch));
  return recordings.filter((recording) => {
    if (
      wantedTitle &&
      normalizeForMatch(recording?.title ?? "") !== wantedTitle
    ) {
      return false;
    }
    if (wantedArtists.size === 0) return true;
    return (recording?.["artist-credit"] ?? []).some(
      (credit: { name?: string }) =>
        wantedArtists.has(normalizeForMatch(credit?.name ?? "")),
    );
  });
}

// Disambiguation text that marks a live, bootleg or remixed recording. Such a recording
// often shares the studio title and length, and MusicBrainz ranks it first. "Edit" and
// "version" are left out: a radio edit or single version is the one playlist mode wants.
const NON_STUDIO_DISAMBIGUATION =
  /\b(live|bootleg|remix|acoustic|demo|karaoke|instrumental|session|dolby atmos|spatial audio)\b/i;

export function scoreRecordingCandidates(
  recordings: any[],
  metadata: MusicBrainzSearchInput,
  options: { preferStudio?: boolean } = {},
) {
  const wantedTitle = normalizeForMatch(
    cleanTitleForSearch(metadata.track ?? ""),
  );
  const wantedTitleRaw = (metadata.track ?? "").toLowerCase();
  const wantedArtists = new Set(metadata.artists.map(normalizeForMatch));
  return recordings
    .filter(
      (recording) => keepMatchingRecordings([recording], metadata).length > 0,
    )
    .map((recording) => {
      const duration = Number(recording.length);
      const delta =
        metadata.durationMs && duration
          ? Math.abs(metadata.durationMs - duration)
          : null;
      const durationScore =
        delta === null ? 0 : Math.max(-50, 20 - delta / 1000);
      const artistMatch = (recording?.["artist-credit"] ?? []).some(
        (credit: { name?: string }) =>
          wantedArtists.has(normalizeForMatch(credit?.name ?? "")),
      );
      // A live or remix copy loses unless the video title asks for it. Playlist mode
      // also wants the single version: a recording on an official Single wins.
      let studioScore = 0;
      const nonStudio = NON_STUDIO_DISAMBIGUATION.exec(
        recording?.disambiguation ?? "",
      )?.[1];
      if (nonStudio && !wantedTitleRaw.includes(nonStudio.toLowerCase())) {
        studioScore -= 40;
      }
      if (options.preferStudio) {
        const onSingle = (recording?.releases ?? []).some(
          (release: any) =>
            release?.status === "Official" &&
            release?.["release-group"]?.["primary-type"] === "Single",
        );
        if (onSingle) studioScore += 25;
      }
      const score =
        (Number(recording.score) || 0) +
        durationScore +
        (artistMatch ? 15 : 0) +
        studioScore;
      return { ...recording, matchScore: score, durationDeltaMs: delta };
    })
    .sort((a, b) => b.matchScore - a.matchScore || a.id.localeCompare(b.id));
}

export function detectPlaylistKind(
  playlistId: string | null | undefined,
  hasMusicBrainzReleaseMatch = false,
): "album" | "playlist" {
  return playlistId?.startsWith("OLAK5uy_") || hasMusicBrainzReleaseMatch
    ? "album"
    : "playlist";
}

export function scoreAlbumCandidates(
  releases: any[],
  title: string,
  artist: string,
  entryCount: number,
) {
  const normalizeAlbumTitle = (value: string) =>
    normalizeForMatch(
      value.replace(
        /\b(?:deluxe|expanded|remastered|anniversary|edition)\b/gi,
        " ",
      ),
    );
  const wantedTitle = normalizeAlbumTitle(title);
  const wantedArtist = normalizeForMatch(artist.replace(/\s+-\s+Topic$/i, ""));
  return (
    releases
      .map((release) => {
        const releaseTitle = normalizeAlbumTitle(release.title ?? "");
        const titleScore =
          releaseTitle === wantedTitle
            ? 0.55
            : releaseTitle.includes(wantedTitle) ||
                wantedTitle.includes(releaseTitle)
              ? 0.4
              : 0.12;
        const credits = (release["artist-credit"] ?? []).map((credit: any) =>
          normalizeForMatch(credit.name ?? credit.artist?.name ?? ""),
        );
        const artistScore = !wantedArtist
          ? 0
          : credits.some((name: string) => name === wantedArtist)
            ? 0.2
            : credits.some(
                  (name: string) =>
                    name.includes(wantedArtist) || wantedArtist.includes(name),
                )
              ? 0.12
              : 0;
        const trackCount = (release.media ?? []).reduce(
          (sum: number, media: any) =>
            sum + Number(media["track-count"] ?? media.track?.length ?? 0),
          0,
        );
        const fitScore =
          entryCount > 0 && trackCount > 0
            ? Math.max(
                0,
                0.2 *
                  (1 -
                    Math.min(
                      1,
                      Math.abs(entryCount - trackCount) /
                        Math.max(entryCount, trackCount),
                    )),
              )
            : 0;
        const score = Math.min(
          1,
          titleScore +
            artistScore +
            fitScore +
            (release.status === "Official" ? 0.05 : 0),
        );
        return {
          releaseId: release.id,
          releaseGroupId: release["release-group"]?.id ?? null,
          title: release.title,
          artist:
            release["artist-credit"]?.map((c: any) => c.name).join(", ") ??
            artist,
          date: release.date ?? null,
          country: release.country ?? null,
          trackCount,
          disambiguation: release.disambiguation || null,
          coverArtUrl: release.id
            ? `https://coverartarchive.org/release/${release.id}/front-250`
            : null,
          official: release.status === "Official",
          hasCover: Boolean(release["cover-art-archive"]?.front),
          score,
        };
      })
      // A release with less than half the playlist's entries cannot be the album (a single
      // title match is not enough), so it is not offered.
      .filter(
        (candidate) =>
          !entryCount ||
          !candidate.trackCount ||
          candidate.trackCount * 2 >= entryCount,
      )
      .sort(comparePressings)
  );
}

export type AlbumCandidate = ReturnType<typeof scoreAlbumCandidates>[number];

// Orders pressings so the same inputs always give the same first pick, whatever order
// MusicBrainz returned them in. Negative when `a` is the better pressing.
export function comparePressings(
  a: {
    score: number;
    official: boolean;
    date: string | null;
    releaseId: string;
  },
  b: {
    score: number;
    official: boolean;
    date: string | null;
    releaseId: string;
  },
) {
  const byId =
    String(a.releaseId) < String(b.releaseId)
      ? -1
      : String(a.releaseId) > String(b.releaseId)
        ? 1
        : 0;
  return (
    b.score - a.score ||
    Number(b.official) - Number(a.official) ||
    Number(Boolean(b.date)) - Number(Boolean(a.date)) ||
    String(a.date ?? "9999").localeCompare(String(b.date ?? "9999")) ||
    byId
  );
}

// Pressings of one edition (same release group and track count) are the same choice, so show the best
// pressing of each edition. Only distinct editions reach the user.
export function collapseAlbumCandidates(
  candidates: AlbumCandidate[],
  limit = 5,
): AlbumCandidate[] {
  const best = new Map<string, AlbumCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.releaseGroupId ?? candidate.releaseId}|${candidate.trackCount}`;
    const current = best.get(key);
    if (!current || comparePressings(candidate, current) < 0)
      best.set(key, candidate);
  }
  return [...best.values()].sort(comparePressings).slice(0, limit);
}

// Asks the user only when the best fit is weak, or a different edition scores about as well and
// fits the YouTube entry count at least as well. Other pressings of the best edition never count, and
// neither does an edition with the wrong number of tracks (a 14-track deluxe for an 11-entry playlist).
export function albumNeedsConfirmation(
  candidates: AlbumCandidate[],
  entryCount: number,
): boolean {
  const top = candidates[0];
  if (!top || top.score < 0.65) return true;
  const trackGap = (candidate: AlbumCandidate) =>
    Math.abs(candidate.trackCount - entryCount);
  const rival = candidates.find(
    (candidate) =>
      candidate.releaseGroupId !== top.releaseGroupId &&
      trackGap(candidate) <= trackGap(top),
  );
  return Boolean(rival && top.score - rival.score < 0.08);
}

export async function fetchMusicBrainzReleases(
  query: string,
  context: MusicBrainzLogContext = {},
) {
  const lookup = {
    ...context,
    musicbrainzLookupId: context.musicbrainzLookupId ?? crypto.randomUUID(),
  };
  const host = "musicbrainz.org";
  const url = `https://${host}/ws/2/release?query=${encodeURIComponent(query)}&fmt=json&limit=25`;
  await logIngestInfo("musicbrainz_release_query_sent", { ...lookup, query });
  for (let attempt = 1; ; attempt++) {
    await waitForMusicBrainzSlot();
    try {
      return await logExternalCall(
        { service: "musicbrainz", host, url, attempt, ...lookup },
        async (record) => {
          const res = await fetchExternal("musicbrainz", host, url, record);
          return parseJson(await res.text(), "MusicBrainz releases");
        },
      );
    } catch (error) {
      if (
        attempt >= MUSICBRAINZ_MAX_ATTEMPTS ||
        !isRetryableMusicBrainzError(error)
      )
        throw error;
      await Bun.sleep(musicBrainzBackoffMs(attempt));
    }
  }
}

// Album jobs for one release share a single lookup. A failed lookup is evicted so the
// next job retries it instead of inheriting the failure. The cache is LRU-capped so a
// long worker run does not grow it without bound.
const MUSICBRAINZ_RELEASE_CACHE_LIMIT = 50;
const musicBrainzReleaseCache = new Map<string, Promise<any>>();

export function musicBrainzReleaseCacheSize() {
  return musicBrainzReleaseCache.size;
}

export function fetchMusicBrainzRelease(
  releaseId: string,
  context: MusicBrainzLogContext = {},
) {
  const cached = musicBrainzReleaseCache.get(releaseId);
  if (cached) {
    // Re-insert so this entry becomes the most recently used.
    musicBrainzReleaseCache.delete(releaseId);
    musicBrainzReleaseCache.set(releaseId, cached);
    return cached;
  }
  const pending: Promise<any> = (async () => {
    const lookup = {
      ...context,
      musicbrainzLookupId: context.musicbrainzLookupId ?? crypto.randomUUID(),
    };
    const host = "musicbrainz.org";
    const url = `https://${host}/ws/2/release/${encodeURIComponent(releaseId)}?inc=recordings+artist-credits+release-groups+media&fmt=json`;
    for (let attempt = 1; ; attempt++) {
      await waitForMusicBrainzSlot();
      try {
        return await logExternalCall(
          { service: "musicbrainz", host, url, attempt, ...lookup },
          async (record) => {
            const res = await fetchExternal("musicbrainz", host, url, record);
            return parseJson(await res.text(), "MusicBrainz release");
          },
        );
      } catch (error) {
        if (
          attempt >= MUSICBRAINZ_MAX_ATTEMPTS ||
          !isRetryableMusicBrainzError(error)
        )
          throw error;
        await Bun.sleep(musicBrainzBackoffMs(attempt));
      }
    }
  })();
  musicBrainzReleaseCache.set(releaseId, pending);
  while (musicBrainzReleaseCache.size > MUSICBRAINZ_RELEASE_CACHE_LIMIT) {
    const oldest = musicBrainzReleaseCache.keys().next().value;
    if (oldest === undefined) break;
    musicBrainzReleaseCache.delete(oldest);
  }
  pending.catch(() => {
    if (musicBrainzReleaseCache.get(releaseId) === pending) {
      musicBrainzReleaseCache.delete(releaseId);
    }
  });
  return pending;
}

// Every release a recording appears on. The recording search lists only a few of them,
// often a live or bootleg release first, so playlist mode needs this lookup to find the
// single. Paced and retried like the other MusicBrainz lookups.
export async function fetchMusicBrainzRecordingReleases(
  recordingId: string,
  context: MusicBrainzLogContext = {},
) {
  const lookup = {
    ...context,
    musicbrainzLookupId: context.musicbrainzLookupId ?? crypto.randomUUID(),
  };
  const host = "musicbrainz.org";
  const url = `https://${host}/ws/2/recording/${encodeURIComponent(recordingId)}?inc=releases+release-groups&fmt=json`;
  for (let attempt = 1; ; attempt++) {
    await waitForMusicBrainzSlot();
    try {
      return await logExternalCall(
        { service: "musicbrainz", host, url, attempt, ...lookup },
        async (record) => {
          const res = await fetchExternal("musicbrainz", host, url, record);
          return parseJson(await res.text(), "MusicBrainz recording");
        },
      );
    } catch (error) {
      if (
        attempt >= MUSICBRAINZ_MAX_ATTEMPTS ||
        !isRetryableMusicBrainzError(error)
      ) {
        throw error;
      }
      await Bun.sleep(musicBrainzBackoffMs(attempt));
    }
  }
}

// Every release in a release group, with track listings. Used by the track-number
// backfill. Paced and retried like the other MusicBrainz lookups, but not cached:
// a backfill walks each group once.
export async function fetchMusicBrainzReleasesForReleaseGroup(
  releaseGroupId: string,
  context: MusicBrainzLogContext = {},
): Promise<any[]> {
  const host = "musicbrainz.org";
  const lookup = {
    ...context,
    musicbrainzLookupId: context.musicbrainzLookupId ?? crypto.randomUUID(),
  };
  const releases: any[] = [];
  for (let offset = 0; ; offset += 100) {
    const url = `https://${host}/ws/2/release?release-group=${encodeURIComponent(releaseGroupId)}&inc=recordings+media&fmt=json&limit=100&offset=${offset}`;
    let page: any;
    for (let attempt = 1; ; attempt++) {
      await waitForMusicBrainzSlot();
      try {
        page = await logExternalCall(
          { service: "musicbrainz", host, url, attempt, ...lookup },
          async (record) => {
            const res = await fetchExternal("musicbrainz", host, url, record);
            return parseJson(await res.text(), "MusicBrainz release group");
          },
        );
        break;
      } catch (error) {
        if (
          attempt >= MUSICBRAINZ_MAX_ATTEMPTS ||
          !isRetryableMusicBrainzError(error)
        )
          throw error;
        await Bun.sleep(musicBrainzBackoffMs(attempt));
      }
    }
    const batch: any[] = page?.releases ?? [];
    releases.push(...batch);
    if (
      !batch.length ||
      releases.length >= Number(page?.["release-count"] ?? 0)
    )
      break;
  }
  return releases;
}

export function matchAlbumRecording(
  release: any,
  title: string | null,
  durationMs: number | null,
  position: number,
) {
  // The playlist position counts across discs, but a track's position is per disc.
  // Each row gets its absolute 1-based index: the tracks on earlier discs plus its own
  // position on this disc.
  const rows: { row: any; absolute: number }[] = [];
  let offset = 0;
  for (const media of release.media ?? []) {
    const tracks: any[] = media.tracks ?? media.track ?? [];
    tracks.forEach((row, index) => {
      const own = Number(row.position);
      rows.push({
        row,
        absolute: offset + (Number.isFinite(own) && own > 0 ? own : index + 1),
      });
    });
    offset += tracks.length;
  }
  if (!rows.length) return null;

  const wanted = normalizeForMatch(cleanTitleForSearch(title ?? ""));
  const wantedIndex = position + 1;
  // A title can appear on more than one disc. Prefer the copy at the playlist position.
  const titled = rows.filter(
    ({ row }) =>
      normalizeForMatch(
        cleanTitleForSearch(row.title ?? row.recording?.title ?? ""),
      ) === wanted,
  );
  const exact = titled.find((c) => c.absolute === wantedIndex) ?? titled[0];
  const candidates = rows.map(({ row }) => ({
    row,
    delta:
      durationMs && Number(row.length ?? row.recording?.length)
        ? Math.abs(durationMs - Number(row.length ?? row.recording?.length))
        : Infinity,
  }));
  const match =
    exact?.row ??
    rows.find((c) => c.absolute === wantedIndex)?.row ??
    candidates.sort((a: any, b: any) => a.delta - b.delta)[0]?.row;
  const recording = match?.recording ?? match;
  return recording?.id ? recording : null;
}

// One search request. Retries transient failures, and each attempt is logged on its own.
async function searchMusicBrainz(
  lookup: MusicBrainzLogContext & { musicbrainzLookupId: string },
  query: string,
  queryStage: "with_release" | "without_release" | "without_version_note",
) {
  // escaping was done when the query was built, so only the URL encoding remains
  const urlParam = encodeURIComponent(query);

  await logIngestInfo("musicbrainz_query_sent", {
    ...lookup,
    query,
    encodedQuery: urlParam,
    queryStage,
  });

  // Query MusicBrainz
  const host = "musicbrainz.org";
  const url = `https://${host}/ws/2/recording?query=${urlParam}&fmt=json`;
  // Each attempt waits for its own slot and writes its own external_call_finished
  // record. The error-body path adds fields to callFields before the call rejects;
  // logExternalCall spreads them into that record.
  for (let attempt = 1; ; attempt++) {
    const callFields: Record<string, unknown> = {
      service: "musicbrainz",
      host,
      url,
      attempt,
      ...lookup,
    };
    await waitForMusicBrainzSlot();
    try {
      return await logExternalCall(callFields, async (record) => {
        const res = await fetchExternal(
          "musicbrainz",
          host,
          url,
          record,
          async (errorRes) => {
            Object.assign(
              callFields,
              await saveMusicBrainzErrorResponse(lookup, errorRes),
            );
          },
        );
        const body = await res.text();
        await saveMusicBrainzResponse(lookup, body);
        return parseJson(body, "MusicBrainz");
      });
    } catch (error) {
      if (
        attempt >= MUSICBRAINZ_MAX_ATTEMPTS ||
        !isRetryableMusicBrainzError(error)
      ) {
        throw error;
      }
      const delayMs = musicBrainzBackoffMs(attempt);
      await logIngestWarning("musicbrainz_retry_scheduled", error, {
        ...lookup,
        attempt,
        nextAttempt: attempt + 1,
        delayMs: Math.round(delayMs),
        ...errorKindFields(error),
      });
      await Bun.sleep(delayMs);
    }
  }
}

// "Dog Days Are Over (2010 Version)": the video title carries a version note that the
// recording title does not have, so the search finds nothing. Drops the last bracket.
function stripTrailingVersionNote(track: string) {
  return track.replace(/\s*\([^()]*\)\s*$/, "").trim();
}

export async function fetchMusicBrainzMetadata(
  metadata: MusicBrainzSearchInput,
  context: MusicBrainzLogContext = {},
  options: { preferStudio?: boolean } = {},
) {
  // one id per lookup, so the query, response file and track record can be linked
  const lookup = {
    ...context,
    musicbrainzLookupId: context.musicbrainzLookupId ?? crypto.randomUUID(),
  };

  // The release is a preference. If the search with it finds nothing, search without it.
  const releaseQuery = buildRecordingQuery(metadata, true);
  const plainQuery = buildRecordingQuery(metadata, false);
  let result = await searchMusicBrainz(lookup, releaseQuery, "with_release");
  if (releaseQuery !== plainQuery && (result.recordings ?? []).length === 0) {
    result = await searchMusicBrainz(lookup, plainQuery, "without_release");
  }

  let scoringInput = metadata;
  let recordings = scoreRecordingCandidates(
    result.recordings ?? [],
    metadata,
    options,
  );
  const bareTrack = stripTrailingVersionNote(metadata.track ?? "");
  if (
    recordings.length === 0 &&
    metadata.track &&
    bareTrack &&
    bareTrack !== metadata.track
  ) {
    scoringInput = { ...metadata, track: bareTrack };
    result = await searchMusicBrainz(
      lookup,
      buildRecordingQuery(scoringInput, false),
      "without_version_note",
    );
    recordings = scoreRecordingCandidates(
      result.recordings ?? [],
      scoringInput,
      options,
    );
  }

  const candidates: any[] = result.recordings ?? [];
  await logIngestInfo("musicbrainz_candidates_filtered", {
    ...lookup,
    candidateCount: candidates.length,
    acceptedCount: recordings.length,
  });
  await logIngestInfo("musicbrainz_candidate_scored", {
    ...lookup,
    candidateCount: recordings.length,
    chosenId: recordings[0]?.id ?? null,
    score: recordings[0]?.matchScore ?? null,
    durationDeltaMs: recordings[0]?.durationDeltaMs ?? null,
    reason:
      recordings.length === 0
        ? "no_exact_title_and_artist_match"
        : recordings[0]?.durationDeltaMs == null
          ? "title_artist_match"
          : "title_artist_and_duration_score",
  });
  return { ...result, recordings };
}

/* FALLBACK RECORDING if musicbrainz recording is malformed or incomplete */
export function createFallbackRecording(parsedYtDlpMetadata: any) {
  const today = new Date().toISOString().slice(0, 10);
  const artist = parsedYtDlpMetadata.artists?.[0] || "Unknown Artist";
  const date = parsedYtDlpMetadata.upload_date || today;
  const hasAlbum = Boolean(parsedYtDlpMetadata.album);

  return {
    id: null,
    title: parsedYtDlpMetadata.track || "Unknown Title",
    "first-release-date": date,
    length: null,
    "artist-credit": [
      {
        name: artist,
        joinphrase: "",
        artist: {
          id: null,
          name: artist,
        },
      },
    ],
    release: {
      "release-group": {
        id: null,
        title: parsedYtDlpMetadata.album || "Single",
        "primary-type": hasAlbum ? "album" : "single",
      },
      date,
    },
  };
}

const REQUIRED_RELEASE_FIELDS = [
  [
    "release-group.id",
    (release: any) => release?.["release-group"]?.id != null,
  ],
  [
    "release-group.primary-type",
    (release: any) => release?.["release-group"]?.["primary-type"] != null,
  ],
  [
    "release-group.title",
    (release: any) => release?.["release-group"]?.title != null,
  ],
  ["date", (release: any) => release?.date != null],
] as const;

export function findFirstCompleteRelease(recording: any) {
  const releases: any[] = recording?.releases ?? [];
  const release = releases.find((candidate) =>
    REQUIRED_RELEASE_FIELDS.every(([, has]) => has(candidate)),
  );

  if (!release) {
    // Group releases by the fields they lack, so the message names the real gaps.
    const gaps = new Map<string, number>();
    for (const candidate of releases) {
      const missing = REQUIRED_RELEASE_FIELDS.filter(
        ([, has]) => !has(candidate),
      ).map(([name]) => name);
      const key = missing.join(", ");
      gaps.set(key, (gaps.get(key) ?? 0) + 1);
    }
    const detail = [...gaps]
      .map(
        ([missing, count]) =>
          `missing ${missing} (${count} ${count === 1 ? "release" : "releases"})`,
      )
      .join("; ");
    throw new Error(
      releases.length === 0
        ? "No complete release found: the recording has no releases"
        : `No complete release found in ${releases.length} ${releases.length === 1 ? "release" : "releases"}: ${detail}`,
    );
  }

  return release;
}

export function selectReleaseForMode(
  recording: any,
  mode: "single" | "album" | "playlist" = "single",
  albumHint?: string | null,
) {
  const complete = (recording?.releases ?? []).filter((candidate: any) =>
    REQUIRED_RELEASE_FIELDS.every(([, has]) => has(candidate)),
  );
  if (!complete.length) return findFirstCompleteRelease(recording);
  const isCompilation = (r: any) =>
    (r["release-group"]?.["secondary-types"] ?? []).some((t: string) =>
      /compilation/i.test(t),
    );
  const official = (r: any) => r.status === "Official";
  const single = (r: any) =>
    /single/i.test(r["release-group"]?.["primary-type"] ?? "");
  const earliest = (r: any) => String(r.date ?? "9999");
  const hint = normalizeForMatch(albumHint ?? "");
  return complete.sort((a: any, b: any) => {
    const rank = (r: any) => {
      let score = official(r) ? 100 : 0;
      if (!isCompilation(r)) score += 30;
      if (mode === "playlist" && single(r)) score += 60;
      if (mode !== "playlist" && single(r)) score -= 20;
      // YouTube's album tag names the album even for a song in a running playlist,
      // so it would outrank the single. Playlist mode ignores it.
      if (mode !== "playlist" && hint && normalizeForMatch(r.title ?? "") === hint)
        score += 150;
      return score;
    };
    return rank(b) - rank(a) || earliest(a).localeCompare(earliest(b));
  })[0];
}

async function getCoverArtForRelease(
  release: any,
  context: Partial<IngestLogContext> = {},
) {
  const host = "coverartarchive.org";
  const url = `https://${host}/release-group/${release["release-group"].id}`;
  // No retry loop here, so every Cover Art call is attempt 1.
  return logExternalCall(
    {
      service: "cover_art",
      host,
      url,
      releaseGroupId: release["release-group"].id,
      attempt: 1,
      ...context,
    },
    async (record) => {
      const res = await fetchExternal("cover_art", host, url, record);
      const data = parseJson(await res.text(), "Cover Art Archive");
      release["release-group"].cover_art_url = data.images[0].image;
      release["release-group"].cover_art_url_thumbnail_large =
        data.images[0].thumbnails.large;
      release["release-group"].cover_art_url_thumbnail_small =
        data.images[0].thumbnails.small;

      return release;
    },
  );
}

export type ReleaseDateSelection = {
  releaseDateSource:
    | "musicbrainz_release"
    | "release_group_first_release"
    | "recording_first_release"
    | "placeholder"
    | "upload_date"
    | "today";
  recordingDateSource:
    "musicbrainz_recording" | "missing" | "upload_date" | "today";
  usedPlaceholderRelease: boolean;
};

// The release the user chose in album mode, when the lookup returned it. A chosen
// release is used even when MusicBrainz left out its date. The date is then filled
// from the release group, the recording, or the YouTube upload date, in that order.
function chosenAlbumRelease(
  recording: any,
  releaseId: string | undefined,
  ytUploadDate: string | null | undefined,
) {
  if (!releaseId) return null;
  const chosen = (recording?.releases ?? []).find(
    (candidate: any) => candidate?.id === releaseId,
  );
  if (!chosen) return null;
  const hasIdentity = REQUIRED_RELEASE_FIELDS.filter(
    ([name]) => name !== "date",
  ).every(([, has]) => has(chosen));
  if (!hasIdentity) return null;

  if (chosen.date != null) {
    return { release: chosen, dateSource: "musicbrainz_release" as const };
  }
  const groupDate = chosen["release-group"]?.["first-release-date"];
  if (groupDate) {
    return {
      release: { ...chosen, date: groupDate },
      dateSource: "release_group_first_release" as const,
    };
  }
  if (recording?.["first-release-date"]) {
    return {
      release: { ...chosen, date: recording["first-release-date"] },
      dateSource: "recording_first_release" as const,
    };
  }
  if (ytUploadDate) {
    return {
      release: { ...chosen, date: ytUploadDate },
      dateSource: "upload_date" as const,
    };
  }
  return {
    release: { ...chosen, date: new Date().toISOString().slice(0, 10) },
    dateSource: "today" as const,
  };
}

// Playlist mode needs every release of the recording to find its single. If the lookup
// fails, the search's partial list is used, as before.
async function withEveryRelease(recording: any, context: IngestLogContext) {
  if (!recording.id) return recording;
  try {
    const full = await fetchMusicBrainzRecordingReleases(recording.id, context);
    return {
      ...recording,
      releases: full.releases ?? recording.releases,
      "first-release-date":
        recording["first-release-date"] ?? full["first-release-date"],
    };
  } catch (error) {
    await logIngestWarning("musicbrainz_recording_lookup_failed", error, {
      ...context,
      stage: "release_selection",
      recordingId: recording.id,
      ...errorKindFields(error),
    });
    return recording;
  }
}

export async function extractRecordingAndRelease(
  musicbrainzmetadata: any,
  ytMetadata: Omit<ParsedYTMetadata, "parsePath">,
  context: IngestLogContext &
    MusicBrainzLogContext & {
      releaseMode?: "single" | "album" | "playlist";
      releaseId?: string;
    },
) {
  let recording = musicbrainzmetadata.recordings?.[0];
  let release;
  let releaseCount: number | undefined;
  let releaseDateSource: ReleaseDateSelection["releaseDateSource"];
  let recordingDateSource: ReleaseDateSelection["recordingDateSource"];
  let usedPlaceholderRelease = false;

  if (recording) {
    releaseCount = recording.releases?.length ?? 0;

    // select a release from all releases in recording
    const chosen =
      context.releaseMode === "album"
        ? chosenAlbumRelease(
            recording,
            context.releaseId,
            ytMetadata.upload_date,
          )
        : null;
    try {
      if (chosen) {
        release = chosen.release;
        releaseDateSource = chosen.dateSource;
        if (chosen.dateSource !== "musicbrainz_release") {
          await logIngestInfo("album_release_date_filled", {
            ...context,
            stage: "release_selection",
            releaseId: release.id ?? null,
            releaseDateSource: chosen.dateSource,
          });
        }
      } else {
        if (context.releaseMode === "playlist") {
          recording = await withEveryRelease(recording, context);
        }
        release = selectReleaseForMode(
          recording,
          context.releaseMode ?? "single",
          ytMetadata.album,
        );
        releaseDateSource = "musicbrainz_release";
      }
    } catch (error) {
      await logIngestWarning("musicbrainz_release_incomplete", error, {
        ...context,
        stage: "release_selection",
        releaseCount,
        recordingId: recording.id ?? null,
      });
      release = {
        date: 0,
        "release-group": {
          "primary-type": "Album",
          title: "Unknown Album",
          id: null,
        },
      };
      releaseDateSource = "placeholder";
      usedPlaceholderRelease = true;
    }

    const recordingFirstRelease = recording["first-release-date"];
    recordingDateSource =
      recordingFirstRelease != null && recordingFirstRelease !== ""
        ? "musicbrainz_recording"
        : "missing";

    if (release["release-group"].id) {
      try {
        release = await getCoverArtForRelease(release, context);
      } catch (error) {
        await logIngestWarning("cover_art_lookup_failed", error, {
          ...context,
          stage: "cover_art_lookup",
          releaseGroupId: release["release-group"].id,
          ...errorKindFields(error),
        });
      }
    }
  } else {
    await logIngestInfo("metadata_fallback_selected", {
      ...context,
      stage: "metadata_reconciliation",
      source: "youtube",
      reason: "no_musicbrainz_recording",
    });
    recording = createFallbackRecording(ytMetadata);
    release = recording.release;
    // Same truthiness test createFallbackRecording uses for `upload_date || today`.
    releaseDateSource = ytMetadata.upload_date ? "upload_date" : "today";
    recordingDateSource = releaseDateSource;
  }

  const selection: ReleaseDateSelection = {
    releaseDateSource,
    recordingDateSource,
    usedPlaceholderRelease,
  };

  await logIngestInfo("release_date_selected", {
    ...context,
    stage: "metadata_reconciliation",
    releaseDateSource,
    recordingDateSource,
    releaseDate: describeDateValue(release.date),
    recordingFirstReleaseDate: describeDateValue(
      recording["first-release-date"],
    ),
    usedPlaceholderRelease,
    ...(releaseCount === undefined ? {} : { releaseCount }),
  });

  return [recording, release, selection] as const;
}

// GET AUDIO LENGTH from the downloaded file if musicbrainz and youtube don't provide it
export async function getAudioLengthMs(filePath: string): Promise<number> {
  const result = await runCommand(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      "--",
      filePath,
    ],
    { timeoutMs: commandTimeoutMs("ffprobe"), label: "ffprobe" },
  );

  const seconds = parseFloat(result.trim());

  if (Number.isNaN(seconds)) {
    throw new Error("Could not determine audio duration");
  }

  return Math.round(seconds * 1000);
}

// Official album playlists (OLAK5uy_) can come without a playlist-level uploader, while
// every entry still credits the album artist. The most common entry channel (without
// " - Topic") is that artist, so the release search can use it instead of the title alone.
export function albumArtistFromEntries(
  entries: { uploader?: string | null; channel?: string | null }[],
): string | null {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const name = String(entry.uploader ?? entry.channel ?? "")
      .replace(/\s+-\s+Topic$/i, "")
      .trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

export function albumSearchTermsFromPlaylist(
  title: string,
  uploader: string | null | undefined,
): { album: string; artist: string | null } {
  const cleanUploader = String(uploader ?? "").trim();
  const topicMatch = cleanUploader.match(/^(.*)\s+-\s+Topic$/i);
  const titleParts = String(title ?? "").split(/\s+-\s+/);
  let artist: string | null = null;
  let rawAlbum = String(title ?? "");
  if (topicMatch) artist = (topicMatch[1] ?? "").trim() || null;
  else if (titleParts.length >= 2 && (titleParts[0] ?? "").trim()) {
    artist = (titleParts[0] ?? "").trim();
    rawAlbum = titleParts.slice(1).join(" - ");
  }
  const album = rawAlbum
    .replace(/\s+-\s+\d{4}\s*$/, "")
    .replace(/[([]\s*full album\s*[)\]]/gi, " ")
    .replace(/\bfull album\b/gi, " ")
    .replace(
      /[([][^)\]]*\b(?:remastered|deluxe|edition|expanded|anniversary)\b[^)\]]*[)\]]/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return { album: album || String(title ?? "").trim(), artist };
}
