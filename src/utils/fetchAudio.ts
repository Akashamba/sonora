import { $ } from "bun";
import {
  logExternalCall,
  logIngestInfo,
  logIngestWarning,
} from "~/utils/ingestLogger";
import { errorKindFields } from "~/utils/networkErrors";

const AUDIO_EXTENSION = ".opus";
// Only known audio extensions are swapped out, so a title with a dot ("Vol.2")
// keeps its name.
const KNOWN_AUDIO_EXTENSION = /\.(opus|ogg|m4a|mp4|webm|mp3)$/i;

// The path a download is stored at. yt-dlp picks the extension itself, so the
// path is computed here and pinned through the output template.
export function opusFilePath(filePath: string): string {
  return filePath.replace(KNOWN_AUDIO_EXTENSION, "") + AUDIO_EXTENSION;
}

export function ytDlpDownloadArgs(youtubeUrl: string, filePath: string): string[] {
  const stem = opusFilePath(filePath).slice(0, -AUDIO_EXTENSION.length);
  // yt-dlp reads % as template syntax, so a literal percent sign is doubled.
  const template = `${stem.replaceAll("%", "%%")}.%(ext)s`;
  return [
    "yt-dlp",
    // Native Opus streams are remuxed, not re-encoded. The fallback only
    // transcodes when YouTube offers no Opus stream for the video.
    "-f",
    "bestaudio[acodec=opus]/bestaudio",
    "--extract-audio",
    "--audio-format",
    "opus",
    "--audio-quality",
    "0",
    // Thumbnails are not embedded: Ogg Opus needs the mutagen module for that.
    // Cover art comes from the Cover Art Archive and is stored in the DB.
    "--embed-metadata",
    "-o",
    template,
    youtubeUrl,
  ];
}

export async function downloadWithRetry(
  youtubeUrl: string,
  filePath: string,
  context: { jobId: string; youtubeId: string },
  retries = 3,
) {
  const outputPath = opusFilePath(filePath);
  const args = ytDlpDownloadArgs(youtubeUrl, filePath);
  for (let i = 0; i < retries; i++) {
    try {
      await logExternalCall(
        {
          service: "yt_dlp_download",
          ...context,
          attempt: i + 1,
        },
        () => $`${args}`,
      );
      // Written to the jsonl file so a download that recovered on retry still has a success record.
      const downloadAttempts = i + 1;
      await logIngestInfo("audio_download_succeeded", {
        ...context,
        stage: "audio_download",
        filePath: outputPath,
        downloadAttempts,
      });
      return downloadAttempts;
    } catch (e) {
      await logIngestWarning("audio_download_attempt_failed", e, {
        ...context,
        stage: "audio_download",
        attempt: i + 1,
        maxAttempts: retries,
        filePath: outputPath,
        ...errorKindFields(e),
      });
      if (i === retries - 1) throw e;
      await Bun.sleep(3000); // 3s delay
    }
  }
}
