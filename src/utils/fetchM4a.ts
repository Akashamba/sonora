import { $ } from "bun";
import {
  logExternalCall,
  logIngestInfo,
  logIngestWarning,
} from "~/utils/ingestLogger";
import { errorKindFields } from "~/utils/networkErrors";

export async function downloadWithRetry(
  youtubeUrl: string,
  filePath: string,
  context: { jobId: string; youtubeId: string },
  retries = 3,
) {
  for (let i = 0; i < retries; i++) {
    try {
      await logExternalCall(
        {
          service: "yt_dlp_download",
          ...context,
          attempt: i + 1,
        },
        () => $`yt-dlp \
        -f bestaudio \
        --extract-audio \
        --audio-format m4a \
        --audio-quality 0 \
        --embed-metadata \
        --embed-thumbnail \
        --convert-thumbnails jpg \
        --postprocessor-args "ffmpeg:-movflags +faststart" \
        -o ${filePath} \
        ${youtubeUrl}`,
      );
      // Written to the jsonl file so a download that recovered on retry still has a success record.
      const downloadAttempts = i + 1;
      await logIngestInfo("audio_download_succeeded", {
        ...context,
        stage: "audio_download",
        filePath,
        downloadAttempts,
      });
      return downloadAttempts;
    } catch (e) {
      await logIngestWarning("audio_download_attempt_failed", e, {
        ...context,
        stage: "audio_download",
        attempt: i + 1,
        maxAttempts: retries,
        filePath,
        ...errorKindFields(e),
      });
      if (i === retries - 1) throw e;
      await Bun.sleep(3000); // 3s delay
    }
  }
}
