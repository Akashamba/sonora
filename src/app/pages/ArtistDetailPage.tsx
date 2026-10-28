import { Icon } from "../components/Icon";
import { useEffect, useState } from "react";
import { BackButton } from "../components/BackButton";
import { TrackRow } from "../components/TrackRow";
import { useApp } from "../context";
import { ENDPOINTS, apiFetch, errorMessage } from "../lib/api";
import { list, stateError, stateMsg } from "../lib/styles";
import type { TrackItem } from "../lib/types";

interface ArtistTracksResponse {
  tracks?: TrackItem[];
  data?: TrackItem[];
}

export function ArtistDetailPage() {
  const { selectedArtist: artist } = useApp();
  const [tracks, setTracks] = useState<TrackItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!artist) return;
    let cancelled = false;
    setTracks(null);
    setError(null);
    apiFetch<TrackItem[] | ArtistTracksResponse>(
      ENDPOINTS.artistTracks(artist.id),
    )
      .then((data) => {
        if (!cancelled)
          setTracks(
            Array.isArray(data) ? data : (data.tracks ?? data.data ?? []),
          );
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [artist]);

  return (
    <>
      <BackButton />
      <div className="mb-8 flex items-start gap-6">
        <div className="flex h-[120px] w-[120px] shrink-0 items-center justify-center overflow-hidden border border-edge bg-surface text-[40px] text-muted">
          <Icon name="person" size={56} />
        </div>
        <div className="flex-1">
          <div className="mb-2 text-[10px] tracking-[0.12em] text-accent uppercase">
            Artist
          </div>
          <div className="mb-2 font-serif text-[28px] italic tracking-[-0.3px]">
            {artist?.name ?? "—"}
          </div>
          <div className="text-xs leading-[1.8] text-muted">All tracks</div>
        </div>
      </div>
      <div className={list}>
        {error ? (
          <div className={`${stateMsg} ${stateError}`}>
            Failed to load: {error}
          </div>
        ) : tracks === null ? (
          <div className={stateMsg}>Loading tracks…</div>
        ) : tracks.length === 0 ? (
          <div className={stateMsg}>No tracks found.</div>
        ) : (
          tracks.map((t) => <TrackRow key={t.id} track={t} />)
        )}
      </div>
    </>
  );
}
