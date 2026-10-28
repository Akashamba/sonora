export type TrackPosition = {
  disc_number: number | null;
  track_number: number | null;
};

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Medium and track position of a recording on a MusicBrainz release. Only a release
// fetched with its track listing has these. A recording search result has no track
// rows, so this returns null and the numbers stay empty.
export function trackPositionOnRelease(
  release: { media?: any[] } | null | undefined,
  recordingId: string | null | undefined,
): TrackPosition | null {
  if (!recordingId) return null;
  for (const medium of release?.media ?? []) {
    for (const row of medium?.tracks ?? medium?.track ?? []) {
      if ((row?.recording?.id ?? null) !== recordingId) continue;
      return {
        disc_number: positiveInt(medium.position),
        track_number: positiveInt(row.position),
      };
    }
  }
  return null;
}
