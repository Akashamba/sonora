// TODO: Group all unknown album songs under the same album, same for artists, not for unknown name

import { rm } from "node:fs/promises";
import { queryTrackByYoutubeId } from "~/server/db/queries/queryTrackByYoutubeId";
import { queryMatches } from "~/server/db/queries/queryTrackMatches";
import { queryTracksByFilePath } from "~/server/db/queries/queryTracksByFilePath";
import { addNewTrack } from "~/server/db/transactions/addNewTrack";
import { trackUniqueConflict } from "~/server/db/transactions/trackUniqueConflict";
import { claimYoutubeId } from "~/services/youtubeIdClaims";
import { trackFileName } from "~/utils/audioPath";
import { COVER_SIZES, ensureCover } from "~/utils/coverCache";
import { downloadWithRetry } from "~/utils/fetchAudio";
import {
  extractRecordingAndRelease,
  fetchMusicBrainzMetadata,
  fetchMusicBrainzRelease,
  fetchYtMetadata,
  getAudioLengthMs,
  logMusicBrainzMatchSelected,
  musicbrainzResponseFileFor,
  matchAlbumRecording,
  parseYouTubeUrl,
} from "~/utils/metadata-utils";
import {
  logIngestFailure,
  logIngestInfo,
  logIngestWarning,
} from "~/utils/ingestLogger";
import { errorKindFields } from "~/utils/networkErrors";
import { db } from "~/server/db";
import { imports, jobs, playlist_tracks } from "~/server/db/schema";
import { and, eq } from "drizzle-orm";

// Links the job to its track and, for a playlist import, adds the track at the job's YouTube position.
// A re-claimed job runs this again, so an entry already at that position is left as it is.
async function linkJobToTrack(jobId: string, trackId: string) {
  let slot: {
    playlistId: string;
    position: number;
    occupiedBy: string | null;
  } | null = null;
  try {
    slot = db.transaction((tx) => {
      tx.update(jobs)
        .set({ track_id: trackId, updated_at: new Date() })
        .where(eq(jobs.id, jobId))
        .run();
      const job = tx
        .select({ importId: jobs.import_id, position: jobs.position })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .get();
      if (!job?.importId || job.position == null) return null;
      const imp = tx
        .select({ playlistId: imports.playlist_id })
        .from(imports)
        .where(eq(imports.id, job.importId))
        .get();
      if (!imp?.playlistId) return null;
      const taken = tx
        .select({ trackId: playlist_tracks.track_id })
        .from(playlist_tracks)
        .where(
          and(
            eq(playlist_tracks.playlist_id, imp.playlistId),
            eq(playlist_tracks.position, job.position),
          ),
        )
        .get();
      if (taken)
        return {
          playlistId: imp.playlistId,
          position: job.position,
          occupiedBy: taken.trackId,
        };
      tx.insert(playlist_tracks)
        .values({
          playlist_id: imp.playlistId,
          track_id: trackId,
          position: job.position,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .run();
      return {
        playlistId: imp.playlistId,
        position: job.position,
        occupiedBy: null,
      };
    });
  } catch (error) {
    await logIngestWarning("job_track_link_failed", error, { jobId, trackId });
    return;
  }
  if (!slot?.occupiedBy) return;
  // The same track on a re-claim is expected. A different track in the slot is not, and is kept out.
  const event =
    slot.occupiedBy === trackId
      ? "playlist_entry_already_present"
      : "playlist_position_taken";
  const fields = {
    jobId,
    trackId,
    playlistId: slot.playlistId,
    position: slot.position,
    occupiedBy: slot.occupiedBy,
  };
  if (event === "playlist_position_taken")
    await logIngestWarning(
      event,
      new Error("playlist position already holds another track"),
      fields,
    );
  else await logIngestInfo(event, fields);
}

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

function importContextForJob(jobId: string) {
  try {
    return db
      .select({
        importId: jobs.import_id,
        position: jobs.position,
        mode: imports.mode,
        releaseId: imports.musicbrainz_release_id,
        releaseGroupId: imports.musicbrainz_release_group_id,
      })
      .from(jobs)
      .leftJoin(imports, eq(imports.id, jobs.import_id))
      .where(eq(jobs.id, jobId))
      .get();
  } catch {
    return undefined;
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
      await linkJobToTrack(jobId, existing[0]!.id);
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

    const importContext = importContextForJob(jobId);
    const importMode =
      importContext?.mode === "album" || importContext?.mode === "playlist"
        ? importContext.mode
        : "single";

    // Get metadata from MusicBrainz. In album mode the chosen release is tried first: its track list
    // settles the match with one request, so the recording search is only a fallback.
    await beginStage("musicbrainz_lookup");
    let musicbrainzmetadata: Awaited<
      ReturnType<typeof fetchMusicBrainzMetadata>
    > | null = null;
    if (importMode === "album" && importContext?.releaseId) {
      try {
        const albumRelease = await fetchMusicBrainzRelease(
          importContext.releaseId,
          { jobId, youtubeId },
        );
        const albumRecording = matchAlbumRecording(
          albumRelease,
          ytMetadata.track,
          ytMetadata.durationMs ?? null,
          importContext.position ?? 0,
        );
        if (albumRecording) {
          musicbrainzmetadata = {
            count: 1,
            recordings: [{ ...albumRecording, releases: [albumRelease] }],
          };
          await logIngestInfo("album_track_match_selected", {
            jobId,
            youtubeId,
            importId: importContext.importId,
            releaseId: albumRelease.id,
            releaseGroupId: albumRelease["release-group"]?.id ?? null,
            recordingId: albumRecording.id,
            recordingTitle: albumRecording.title,
            position: importContext.position,
          });
        }
      } catch (error) {
        await logIngestWarning("album_release_lookup_failed", error, {
          jobId,
          youtubeId,
          importId: importContext.importId,
          releaseId: importContext.releaseId,
        });
      }
    }
    musicbrainzmetadata ??= await fetchMusicBrainzMetadata(
      ytMetadata,
      { jobId, youtubeId, musicbrainzLookupId },
      { preferStudio: importMode === "playlist" },
    );
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
      await linkJobToTrack(jobId, matches[0]!.id);
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
        releaseMode: importMode,
        releaseId:
          importMode === "album"
            ? (importContext?.releaseId ?? undefined)
            : undefined,
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
      // track is the answer, so this job links to it and completes. It saved no track,
      // so trackCommitted stays unset.
      const conflict = trackUniqueConflict(error);
      if (!conflict) throw error;
      const recordingKey = recording.id ?? "";
      const matches = await queryMatches(youtubeId, recordingKey);
      if (matches.length === 0) throw error;
      // Prefer the track that owns this video, since that is the key the conflict was on.
      const stored =
        matches.find((match) => match.youtube_id === youtubeId) ?? matches[0]!;
      await linkJobToTrack(jobId, stored.id);
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
    const storedTrack = await queryTrackByYoutubeId(youtubeId);
    if (storedTrack[0]?.id) await linkJobToTrack(jobId, storedTrack[0].id);
    progress.trackCommitted = true;
    await completeStage({ filePath });
    // Cache the cover now so the first time the album is shown doesn't wait on archive.org.
    // A failed download is retried when the cover is first requested.
    const releaseGroupId = storedTrack[0]?.releaseGroupId;
    if (releaseGroupId) {
      await Promise.all(
        COVER_SIZES.map(async (size) => {
          const result = await ensureCover(releaseGroupId, size);
          if (result.cached || !result.error) return;
          await logIngestWarning("cover_cache_failed", result.error, {
            ...context(),
            stage: "cover_cache",
            releaseGroupId,
            size,
            ...errorKindFields(result.error),
          });
        }),
      );
    }
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
