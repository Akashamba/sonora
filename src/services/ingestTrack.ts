// TODO: Group all unknown album songs under the same album, same for artists, not for unknown name

import { rm } from "node:fs/promises";
import { queryTrackByYoutubeId } from "~/server/db/queries/queryTrackByYoutubeId";
import { queryMatches } from "~/server/db/queries/queryTrackMatches";
import { queryTracksByFilePath } from "~/server/db/queries/queryTracksByFilePath";
import { addNewTrack } from "~/server/db/transactions/addNewTrack";
import { trackUniqueConflict } from "~/server/db/transactions/trackUniqueConflict";
import { claimYoutubeId } from "~/services/youtubeIdClaims";
import { trackFileName } from "~/utils/audioPath";
import { downloadWithRetry } from "~/utils/fetchAudio";
import {
  extractRecordingAndRelease,
  fetchMusicBrainzMetadata,
  fetchYtMetadata,
  getAudioLengthMs,
  logMusicBrainzMatchSelected,
  musicbrainzResponseFileFor,
  parseYouTubeUrl,
} from "~/utils/metadata-utils";
import {
  logIngestFailure,
  logIngestInfo,
  logIngestWarning,
} from "~/utils/ingestLogger";
import { errorKindFields } from "~/utils/networkErrors";

// Which of the two keys a stored track matched on. Same comparisons as queryMatches.
function matchedByKeys(
  matches: { youtube_id: string; musicbrainz_recording_id: string | null }[],
  youtubeId: string,
  recordingId: string,
) {
  return [
    ...(matches.some((match) => match.youtube_id === youtubeId)
      ? ["youtube_id"]
      : []),
    ...(matches.some((match) => match.musicbrainz_recording_id === recordingId)
      ? ["recording_id"]
      : []),
  ];
}

// Deletes the downloaded file unless a track row still points at it. Two jobs for the
// same video share one path, and the stored track owns that file.
async function removeFileIfUnreferenced(filePath: string, context: object) {
  try {
    const owners = await queryTracksByFilePath(filePath);
    if (owners.length > 0) return false;
    await rm(filePath, { force: true });
    return true;
  } catch (error) {
    await logIngestWarning("orphan_audio_remove_failed", error, {
      ...context,
      filePath,
    });
    return false;
  }
}

// Logging only. Records whether the target path already exists and which tracks
// already own it in the DB. Never throws, so it cannot change the ingest outcome.
export async function logAudioPathState(
  filePath: string,
  context: Record<string, unknown>,
) {
  try {
    const fileExisted = await Bun.file(filePath).exists();
    const owners = await queryTracksByFilePath(filePath);
    await logIngestInfo("audio_path_checked", {
      ...context,
      filePath,
      fileExisted,
      ownerCount: owners.length,
      ownerYoutubeIds: owners.map((owner) => owner.youtubeId),
      ownerTrackIds: owners.map((owner) => owner.id),
    });
  } catch (error) {
    await logIngestWarning("audio_path_check_failed", error, {
      ...context,
      filePath,
    });
  }
}

// Filled in as the ingest runs, so a caller still knows what was saved if the
// ingest throws afterwards.
export type IngestProgress = { trackCommitted?: boolean };

// for a given url:
// - skip if the youtube id is already in db
// - fetch metadata from youtube
// - Looks up high quality metadata from musicbrainz. use fallback data if not available
// - check if the recording is already in db, if not download
// - write to db
// `timing.queuedForMs` is the wait between the job's creation and its claim. The
// caller measures it, since only the worker knows when the job was claimed.
export async function ingestTrack(
  url: string,
  jobId: string,
  progress: IngestProgress = {},
  timing: { queuedForMs?: number } = {},
) {
  let youtubeId: string | undefined;
  let releaseYoutubeId: (() => void) | undefined;
  let stage = "parse_youtube_url";
  let stageStartedAt = Date.now();
  const ingestStartedAt = performance.now();
  const musicbrainzLookupId = crypto.randomUUID();
  const musicbrainzResponseFile =
    musicbrainzResponseFileFor(musicbrainzLookupId);
  const context = () => ({
    jobId,
    youtubeId,
    sourceUrl: url,
    stage,
    musicbrainzLookupId,
  });
  const beginStage = async (nextStage: string) => {
    stage = nextStage;
    stageStartedAt = Date.now();
    await logIngestInfo("ingest_stage_started", context());
  };
  const completeStage = async (fields: Record<string, unknown> = {}) => {
    await logIngestInfo("ingest_stage_completed", {
      ...context(),
      durationMs: Date.now() - stageStartedAt,
      ...fields,
    });
  };

  try {
    await logIngestInfo("ingest_started", { jobId, sourceUrl: url });
    // parse url to confirm validity and extract id
    await beginStage("parse_youtube_url");
    const [parsedYoutubeId, youtubeUrl] = parseYouTubeUrl(url);
    youtubeId = parsedYoutubeId;
    await completeStage({ youtubeId });

    // Skip a YouTube id that is already stored, before any network call
    await beginStage("youtube_id_check");
    // Waits here if another job in this process is already ingesting the same video.
    const claim = await claimYoutubeId(youtubeId);
    releaseYoutubeId = claim.release;
    if (claim.waited)
      await logIngestInfo("ingest_waited_for_youtube_id", context());
    const existing = await queryTrackByYoutubeId(youtubeId);
    if (existing.length > 0) {
      await completeStage({ duplicate: true, matchCount: existing.length });
      await logIngestInfo("ingest_skipped_duplicate", {
        ...context(),
        detectedAt: "youtube_id_check",
        matchCount: existing.length,
        matchedBy: ["youtube_id"],
        matchedTrackIds: existing.map((track) => track.id),
        totalDurationMs: Math.round(performance.now() - ingestStartedAt),
        queuedForMs: timing.queuedForMs,
      });
      return;
    }
    await completeStage({ duplicate: false });

    // Get metadata from YouTube
    await beginStage("youtube_metadata");
    const ytMetadata = await fetchYtMetadata(youtubeUrl, {
      jobId,
      youtubeId,
    });
    await completeStage({
      track: ytMetadata.track,
      album: ytMetadata.album,
      artists: ytMetadata.artists,
    });

    // Get metadata from MusicBrainz
    await beginStage("musicbrainz_lookup");
    const musicbrainzmetadata = await fetchMusicBrainzMetadata(ytMetadata, {
      jobId,
      youtubeId,
      musicbrainzLookupId,
    });
    const musicbrainzRecording = musicbrainzmetadata?.recordings?.[0];
    await completeStage({
      resultCount:
        musicbrainzmetadata?.count ??
        musicbrainzmetadata?.recordings?.length ??
        0,
      selectedRecordingId: musicbrainzRecording?.id ?? null,
    });
    await logMusicBrainzMatchSelected(musicbrainzmetadata, {
      ...context(),
      musicbrainzResponseFile,
    });

    // Check if track already exists
    await beginStage("duplicate_check");
    const recordingId = musicbrainzRecording?.id ?? "";
    const matches = await queryMatches(youtubeId, recordingId);
    if (matches.length > 0) {
      const matchedBy = matchedByKeys(matches, youtubeId, recordingId);
      await completeStage({ duplicate: true, matchCount: matches.length });
      await logIngestInfo("ingest_skipped_duplicate", {
        ...context(),
        detectedAt: "duplicate_check",
        matchCount: matches.length,
        matchedBy,
        matchedTrackIds: matches.map((match) => match.id),
        totalDurationMs: Math.round(performance.now() - ingestStartedAt),
        queuedForMs: timing.queuedForMs,
      });
      return;
    }
    await completeStage({ duplicate: false });

    // Extract recording and release information with fallback
    await beginStage("metadata_reconciliation");
    const [recording, release, dateSelection] =
      await extractRecordingAndRelease(musicbrainzmetadata, ytMetadata, {
        jobId,
        youtubeId,
        musicbrainzLookupId,
        musicbrainzResponseFile,
      });
    await completeStage({
      selectedTitle: recording.title,
      selectedRelease: release["release-group"]?.title,
      artistCount: recording["artist-credit"]?.length ?? 0,
      metadataSource: recording.id ? "musicbrainz" : "youtube_fallback",
      usedPlaceholderRelease: dateSelection.usedPlaceholderRelease,
      releaseDateSource: dateSelection.releaseDateSource,
    });

    // If not, download track
    const filePath = `audio/${trackFileName(recording.title, youtubeId)}`;
    await beginStage("audio_download");
    await logAudioPathState(filePath, context());
    const downloadAttempts = await downloadWithRetry(youtubeUrl, filePath, {
      jobId,
      youtubeId,
    });
    await completeStage({ filePath, downloadAttempts });

    let audioLength = recording.length;
    if (audioLength == null) {
      await beginStage("audio_duration_probe");
      audioLength = await getAudioLengthMs(filePath);
      await completeStage({ audioLengthMs: audioLength });
    }

    // Write to db
    await beginStage("database_write");
    try {
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
        { jobId, musicbrainzLookupId, musicbrainzResponseFile },
      );
    } catch (error) {
      // Another job stored this video or recording after the check above. The stored
      // track is the answer, so this job completes as a duplicate. It saved no track,
      // so trackCommitted stays unset.
      const conflict = trackUniqueConflict(error);
      if (!conflict) throw error;
      const recordingKey = recording.id ?? "";
      const matches = await queryMatches(youtubeId, recordingKey);
      if (matches.length === 0) throw error;
      const fileRemoved = await removeFileIfUnreferenced(filePath, context());
      await completeStage({ duplicate: true, matchCount: matches.length });
      await logIngestInfo("ingest_skipped_duplicate", {
        ...context(),
        detectedAt: "insert",
        conflict,
        filePath,
        fileRemoved,
        matchCount: matches.length,
        matchedBy: matchedByKeys(matches, youtubeId, recordingKey),
        matchedTrackIds: matches.map((match) => match.id),
        totalDurationMs: Math.round(performance.now() - ingestStartedAt),
        queuedForMs: timing.queuedForMs,
      });
      return;
    }
    progress.trackCommitted = true;
    await completeStage({ filePath });
    await logIngestInfo("ingest_completed", {
      ...context(),
      trackTitle: recording.title,
      filePath,
      totalDurationMs: Math.round(performance.now() - ingestStartedAt),
      queuedForMs: timing.queuedForMs,
    });
  } catch (err) {
    await logIngestFailure("ingest_failed", err, {
      ...context(),
      durationMs: Date.now() - stageStartedAt,
      totalDurationMs: Math.round(performance.now() - ingestStartedAt),
      queuedForMs: timing.queuedForMs,
      ...errorKindFields(err),
    });
    throw err;
  } finally {
    releaseYoutubeId?.();
  }
}
