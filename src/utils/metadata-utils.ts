import { $ } from "bun";
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
    () => $`yt-dlp --flat-playlist --print "%(url)s" ${url}`.text(),
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
        await $`yt-dlp --dump-json ${url}`.text(),
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
    parsePath,
  };
}

function splitArtists(input: string): string[] {
  return input
    .split(/\s+(?:&|x|feat\.?|ft\.?|with|and)\s+/i)
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
    score: recording?.score ?? null,
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

export async function fetchMusicBrainzMetadata(
  metadata: {
    artists: string[];
    album: string | null;
    track: string | null;
  },
  context: MusicBrainzLogContext = {},
) {
  // one id per lookup, so the query, response file and track record can be linked
  const lookup = {
    ...context,
    musicbrainzLookupId: context.musicbrainzLookupId ?? crypto.randomUUID(),
  };

  // build query
  let query = "";

  metadata.track && (query += `${metadata.track}`);
  metadata.album && (query += ` AND album:${metadata.album}`);
  if (metadata.artists.length > 0) {
    metadata.artists.forEach((artist) => (query += ` AND artist:${artist}`));
  }

  // escaping special characters for lucene and encoding to be suitable for a url
  const luceneEscape = (str: string) =>
    str.replace(/([+\-&|!(){}[\]^"~*?:\\\/])/g, "\\$1");
  const escaped = luceneEscape(query);
  const urlParam = encodeURIComponent(escaped);

  await logIngestInfo("musicbrainz_query_sent", {
    ...lookup,
    query: escaped,
    encodedQuery: urlParam,
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

export function findFirstCompleteRelease(recording: any) {
  const release = recording?.releases?.find(
    (release: { [x: string]: any; date: null }) => {
      const group = release?.["release-group"];
      return (
        group?.id != null &&
        group?.["primary-type"] != null &&
        group?.title != null &&
        release?.date != null
      );
    },
  );

  if (!release) {
    throw new Error(
      "No complete release found: all releases are missing one or more required fields (release-group.id, release-group.primary-type, release-group.title, date)",
    );
  }

  return release;
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
    "musicbrainz_release" | "placeholder" | "upload_date" | "today";
  recordingDateSource:
    "musicbrainz_recording" | "missing" | "upload_date" | "today";
  usedPlaceholderRelease: boolean;
};

export async function extractRecordingAndRelease(
  musicbrainzmetadata: any,
  ytMetadata: Omit<ParsedYTMetadata, "parsePath">,
  context: IngestLogContext & MusicBrainzLogContext,
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
    try {
      release = findFirstCompleteRelease(recording);
      releaseDateSource = "musicbrainz_release";
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

// GET AUDIO LENGTH from m4a if musicbrainz and youtube don't provide it
export async function getAudioLengthMs(filePath: string): Promise<number> {
  const result =
    await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${filePath}`.text();

  const seconds = parseFloat(result.trim());

  if (Number.isNaN(seconds)) {
    throw new Error("Could not determine audio duration");
  }

  return Math.round(seconds * 1000);
}
