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
