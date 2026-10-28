export type TrackUniqueConflict = "youtube_id" | "musicbrainz_recording_id";

const UNIQUE_CONFLICT =
  /UNIQUE constraint failed: tracks_table\.(youtube_id|musicbrainz_recording_id)/;

// Which unique column of tracks_table an insert hit, or null for any other error.
// The driver may wrap the SQLite error, so the cause chain is searched too.
export function trackUniqueConflict(
  error: unknown,
): TrackUniqueConflict | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const message = (current as { message?: unknown }).message;
    const match =
      typeof message === "string" ? UNIQUE_CONFLICT.exec(message) : null;
    if (match) return match[1] as TrackUniqueConflict;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
