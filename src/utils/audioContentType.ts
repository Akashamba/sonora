import { extname } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".opus": "audio/ogg; codecs=opus",
  ".ogg": "audio/ogg; codecs=opus",
  // Existing library rows are still .m4a, so they keep their original type.
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".webm": "audio/webm",
  ".mp3": "audio/mpeg",
};

export function audioContentType(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
