import { BackButton } from "../components/BackButton";
import { TrackRow } from "../components/TrackRow";
import { useApp } from "../context";
import {
  list,
  pageSubtitle,
  pageTitle,
  stateError,
  stateMsg,
} from "../lib/styles";

export function QueuePage() {
  const { queue, player } = useApp();
  const { tracks, loading, error } = queue;

  const subtitle = error
    ? "error"
    : tracks === null
      ? "Loading…"
      : `${tracks.length} upcoming`;

  return (
    <>
      <BackButton />
      <div className={pageTitle}>Queue</div>
      <div className={pageSubtitle}>{subtitle}</div>
      <div className={list}>
        {loading ? (
          <div className={stateMsg}>Loading queue…</div>
        ) : error ? (
          <div className={`${stateMsg} ${stateError}`}>
            Failed to load: {error}
          </div>
        ) : tracks && tracks.length === 0 ? (
          <div className={stateMsg}>Queue is empty.</div>
        ) : (
          tracks?.map((t, i) => {
            // Tapping a row plays it and drops the rows above it (Apple Music behaviour). Rows
            // without a queue position cannot be addressed, so they stay off.
            const position = t.position;
            return (
              <TrackRow
                key={`${t.id}-${i}`}
                track={t}
                index={i}
                playable={position != null}
                onPlay={
                  position != null
                    ? () => player.playFromUpNext(position)
                    : undefined
                }
              />
            );
          })
        )}
      </div>
    </>
  );
}
