import { $ } from "bun";

export async function downloadWithRetry(
  youtubeUrl: string,
  filePath: string,
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
      console.log("Download complete");
      return;
    } catch (e) {
      if (i === retries - 1) throw e;
      console.log("Error while downloading:", (e as Error).message);
      console.log("Retrying in 3 seconds...");
      await Bun.sleep(3000); // 3s delay
    }
  }
}
