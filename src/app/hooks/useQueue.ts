import { useCallback, useState } from "react";
import { ENDPOINTS, apiFetch, errorMessage } from "../lib/api";
import type { TrackItem } from "../lib/types";

interface QueueResponse {
  data: TrackItem[];
}

export function useQueue() {
  // `tracks` stays null until the first load finishes, so the subtitle can read "Loading…".
  const [tracks, setTracks] = useState<TrackItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<QueueResponse>(ENDPOINTS.queue());
      // Ported as-is from the vanilla version. A boolean comparator never returns a
      // negative value, so this keeps the API order rather than sorting by position.
      const sorted = res.data.sort((a, b) =>
        (a.position ?? 0) > (b.position ?? 0) ? 1 : 0,
      );
      setTracks(sorted);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  return { tracks, loading, error, load };
}

export type Queue = ReturnType<typeof useQueue>;
