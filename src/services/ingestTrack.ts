// TODO: Group all unknown album songs under the same album, same for artists, not for unknown name

import { queryMatches } from "~/server/db/queries/queryTrackMatches";
import { addNewTrack } from "~/server/db/transactions/addNewTrack";
import { sanitizeFileName } from "~/utils/audioPath";
import { downloadWithRetry } from "~/utils/fetchM4a";
import {
  extractRecordingAndRelease,
  fetchMusicBrainzMetadata,
  fetchYtMetadata,
  getAudioLengthMs,
  parseYouTubeUrl,
} from "~/utils/metadata-utils";
import { logIngestFailure, logIngestSuccess } from "~/utils/ingestLogger";

// for a given url:
// - fetch metadata from youtube
// - Looks up high quality metadata from musicbrainz. use fallback data if not available
// - check if already in db, if not download
// - write to db
export async function ingestTrack(url: string, jobId: string) {
  let youtubeId: string | undefined;
  let stage = "parse_youtube_url";
  let stageStartedAt = Date.now();
  const context = () => ({ jobId, youtubeId, sourceUrl: url, stage });
  const beginStage = (nextStage: string) => {
    stage = nextStage;
    stageStartedAt = Date.now();
    logIngestSuccess("ingest_stage_started", context());
  };
  const completeStage = (fields: Record<string, unknown> = {}) => {
    logIngestSuccess("ingest_stage_completed", {
      ...context(),
      durationMs: Date.now() - stageStartedAt,
      ...fields,
    });
  };

  try {
    logIngestSuccess("ingest_started", { jobId, sourceUrl: url });
    // parse url to confirm validity and extract id
    beginStage("parse_youtube_url");
    const [parsedYoutubeId, youtubeUrl] = parseYouTubeUrl(url);
    youtubeId = parsedYoutubeId;
    completeStage({ youtubeId });

    // Get metadata from YouTube
    beginStage("youtube_metadata");
    const ytMetadata = await fetchYtMetadata(youtubeUrl);
    completeStage({
      track: ytMetadata.track,
      album: ytMetadata.album,
      artists: ytMetadata.artists,
    });

    // Get metadata from MusicBrainz
    beginStage("musicbrainz_lookup");
    const musicbrainzmetadata = await fetchMusicBrainzMetadata(ytMetadata);
    const musicbrainzRecording = musicbrainzmetadata?.recordings?.[0];
    completeStage({
      resultCount:
        musicbrainzmetadata?.count ??
        musicbrainzmetadata?.recordings?.length ??
        0,
      selectedRecordingId: musicbrainzRecording?.id ?? null,
    });

    // Check if track already exists
    beginStage("duplicate_check");
    const matches = await queryMatches(
      youtubeId,
      musicbrainzRecording?.id ?? "",
    );
    if (matches.length > 0) {
      completeStage({ duplicate: true, matchCount: matches.length });
      logIngestSuccess("ingest_skipped_duplicate", {
        ...context(),
        matchCount: matches.length,
      });
      return;
    }
    completeStage({ duplicate: false });

    // Extract recording and release information with fallback
    beginStage("metadata_reconciliation");
    const [recording, release] = await extractRecordingAndRelease(
      musicbrainzmetadata,
      ytMetadata,
      { jobId, youtubeId },
    );
    completeStage({
      selectedTitle: recording.title,
      selectedRelease: release["release-group"]?.title,
      artistCount: recording["artist-credit"]?.length ?? 0,
      metadataSource: recording.id ? "musicbrainz" : "youtube_fallback",
    });

    // If not, download track
    const filePath = `audio/${sanitizeFileName(recording.title)}.m4a`;
    beginStage("audio_download");
    const downloadAttempts = await downloadWithRetry(youtubeUrl, filePath, {
      jobId,
      youtubeId,
    });
    completeStage({ filePath, downloadAttempts });

    let audioLength = recording.length;
    if (audioLength == null) {
      beginStage("audio_duration_probe");
      audioLength = await getAudioLengthMs(filePath);
      completeStage({ audioLengthMs: audioLength });
    }

    // Write to db
    beginStage("database_write");
    await addNewTrack(
      {
        release: release,
        recording: {
          ...recording,
          length: audioLength ?? 0,
        },
        youtubeId: youtubeId,
        filePath: filePath,
      },
      { jobId },
    );
    completeStage({ filePath });
    logIngestSuccess("ingest_completed", {
      ...context(),
      trackTitle: recording.title,
      filePath,
    });
  } catch (err) {
    await logIngestFailure("ingest_failed", err, {
      ...context(),
      durationMs: Date.now() - stageStartedAt,
    });
    throw err;
  }
}
