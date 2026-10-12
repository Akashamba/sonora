import { $ } from "bun";
import { logIngestWarning } from "~/utils/ingestLogger";

export async function downloadWithRetry(
  youtubeUrl: string,
  filePath: string,
  context: { jobId: string; youtubeId: string },
  retries = 3,
) {
  for (let i = 0; i < retries; i++) {
    try {
      await $`yt-dlp \
        -f bestaudio \
        --extract-audio \
        --audio-format m4a \
        --audio-quality 0 \
        --embed-metadata \
        --embed-thumbnail \
        --convert-thumbnails jpg \
        --postprocessor-args "ffmpeg:-movflags +faststart" \
        -o ${filePath} \
        ${youtubeUrl}`;
      return i + 1;
    } catch (e) {
      await logIngestWarning("audio_download_attempt_failed", e, {
        ...context,
        stage: "audio_download",
        attempt: i + 1,
        maxAttempts: retries,
        filePath,
      });
      if (i === retries - 1) throw e;
      await Bun.sleep(3000); // 3s delay
    }
  }
}
