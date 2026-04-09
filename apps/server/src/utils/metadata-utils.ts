import { $ } from "bun";

type ParsedYTMetadata = {
  artists: string[];
  track: string | null;
  album: string | null;
  upload_date: string | null;
};

export async function getAllUrlsFromPlaylist(url: string): Promise<string[]> {
  // if it's not a playlist, just return it
  if (!url.includes("list=")) return [url];

  const output =
    await $`yt-dlp --flat-playlist --print "%(url)s" ${url}`.text();

  return output.trim().split("\n").filter(Boolean);
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
export async function fetchYtMetadata(url: string) {
  const metadata = await $`yt-dlp --dump-json ${url}`.text();
  return parseYtDlpMetadata(metadata);
}

export function parseYtDlpMetadata(metadata: string): ParsedYTMetadata {
  const parsedMetadata = JSON.parse(metadata);
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
  const upload_date = formatUploadDate(parsedMetadata.upload_date);

  if (parsedMetadata.artist) {
    artists = splitArtists(parsedMetadata.artist);
  }

  // Fallback to parsing title
  if (!track || artists.length === 0) {
    console.log("original:", parsedMetadata.title);
    const title = clean(parsedMetadata.title ?? "");
    console.log("cleaned title:", title);

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
export async function fetchMusicBrainzMetadata(metadata: {
  artists: string[];
  album: string | null;
  track: string | null;
}) {
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

  console.log("Sending query to MusicBrainz:", urlParam);

  // Query MusicBrainz
  const res = await fetch(
    `https://musicbrainz.org/ws/2/recording?query=${urlParam}&fmt=json`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "sonora/0.1",
      },
    },
  );

  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }

  const data = await res.json();
  return data;
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

async function getCoverArtForRelease(release: any) {
  const res = await fetch(
    `https://coverartarchive.org/release-group/${release["release-group"].id}`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "sonora/0.1",
      },
    },
  );

  if (res.ok) {
    const data = await res.json();
    release["release-group"].cover_art_url = data.images[0].image;
    release["release-group"].cover_art_url_thumbnail_large =
      data.images[0].thumbnails.large;
    release["release-group"].cover_art_url_thumbnail_small =
      data.images[0].thumbnails.small;
  }

  return release;
}

export async function extractRecordingAndRelease(musicbrainzmetadata: any) {
  let recording = musicbrainzmetadata.recordings?.[0];
  let release;

  if (recording) {
    // select a release from all releases in recording
    try {
      release = findFirstCompleteRelease(recording);
    } catch {
      console.log("No complete release found. Defaulting to unknown");
      release = {
        date: 0,
        "release-group": {
          "primary-type": "Album",
          title: "Unknown Album",
          id: null,
        },
      };
    }

    try {
      release = await getCoverArtForRelease(release);
    } catch {
      console.log(
        "Error while trying to get cover art. Proceeding without cover art.",
      );
    }
  } else {
    console.log(
      "No MusicBrainz metadata found, falling back to YouTube metadata",
    );

    recording = createFallbackRecording(parseYtDlpMetadata);
    release = recording.release;
  }

  return [recording, release];
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
