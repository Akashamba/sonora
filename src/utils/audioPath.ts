// can also upgrade to return signed url if necessary
export const audioPath = (filename: string) =>
  `${process.env.AUDIO_PATH}/${filename}`;

// util to remove any special and reserved chars from filename
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "") // remove forbidden Windows/Unix chars
    .replace(/\s+/g, "_") // replace spaces with underscores
    .substring(0, 255); // optional: max filename length
}

// Filesystems cap names at 255 bytes, not characters.
const MAX_FILE_NAME_BYTES = 255;
const AUDIO_SUFFIX = ".opus";
const utf8 = new TextEncoder();

// Cuts text to at most maxBytes of UTF-8 without splitting a character.
function truncateToBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const char of text) {
    bytes += utf8.encode(char).length;
    if (bytes > maxBytes) break;
    result += char;
  }
  return result;
}

// File name for a downloaded track: `<title>_<youtubeId>.opus`. The YouTube id
// makes it unique per video, so two videos with the same title never share a
// file. Only the title is truncated, so the id and extension always survive.
export function trackFileName(title: string, youtubeId: string): string {
  const suffix = `_${youtubeId}${AUDIO_SUFFIX}`;
  const titleBudget = MAX_FILE_NAME_BYTES - utf8.encode(suffix).length;
  return `${truncateToBytes(sanitizeFileName(title), titleBudget)}${suffix}`;
}
