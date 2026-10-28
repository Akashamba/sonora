import { useApp } from "../context";
import { artistCredit } from "../lib/format";
import { Icon } from "./Icon";

const time = (value: number) =>
  `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;

export function PlayerDock() {
  const { player, nav, openQueue } = useApp();
  const { track, cover, playing, currentTime, duration, loadError } = player;
  if (!track && !loadError) return null;
  // A failed load names the track that failed; the player then skips ahead on its own.
  const title = loadError?.title ?? track?.title ?? "";
  const credit = loadError
    ? "Could not load, skipping…"
    : artistCredit(track?.artists);
  const openNowPlaying = () => nav.go("player-page", nav.page);
  return (
    <>
      <div className="player-dock">
        <button
          className="dock-track"
          onClick={openNowPlaying}
          title="Open Now Playing"
        >
          <span className="dock-art">
            {cover && <img src={cover} alt="" />}
          </span>
          <span className="dock-copy">
            <strong>{title}</strong>
            <small>{credit}</small>
          </span>
        </button>
        <div className="dock-center">
          <div className="dock-controls">
            <button aria-label="Previous track" onClick={player.skipPrevious}>
              <Icon name="prev" size={20} />
            </button>
            <button
              className="dock-play"
              aria-label={playing ? "Pause" : "Play"}
              onClick={player.togglePlayPause}
            >
              <Icon name={playing ? "pause" : "play"} size={16} />
            </button>
            <button aria-label="Next track" onClick={player.skipNext}>
              <Icon name="next" size={20} />
            </button>
          </div>
          <div className="dock-scrubber">
            <span>{time(currentTime)}</span>
            <input
              aria-label="Playback position"
              type="range"
              min={0}
              max={duration || 1}
              value={Math.min(currentTime, duration || 1)}
              onChange={(e) => player.seekTo(Number(e.target.value))}
            />
            <span>{time(duration)}</span>
          </div>
        </div>
        <div className="dock-tools">
          <button
            aria-label="Like track"
            className={player.liked ? "liked" : ""}
            onClick={player.toggleLike}
          >
            <Icon name={player.liked ? "heart" : "heartOutline"} size={18} />
          </button>
          <button aria-label="Queue" onClick={openQueue}>
            <Icon name="queue" size={18} />
          </button>
          <Icon name="volumeLow" size={16} className="volume-icon" />
          <input
            aria-label="Volume"
            className="volume-range"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={player.volume}
            onChange={(e) => player.setVolume(Number(e.target.value))}
          />
        </div>
      </div>
      <div
        className="mobile-mini-player"
        onClick={openNowPlaying}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter") openNowPlaying();
        }}
      >
        <span className="dock-art">{cover && <img src={cover} alt="" />}</span>
        <span className="dock-copy">
          <strong>{title}</strong>
          <small>{credit}</small>
        </span>
        <button
          className="mini-play"
          aria-label={playing ? "Pause" : "Play"}
          onClick={(e) => {
            e.stopPropagation();
            player.togglePlayPause();
          }}
        >
          <Icon name={playing ? "pause" : "play"} size={22} />
        </button>
        <button
          className="mini-next"
          aria-label="Next track"
          onClick={(e) => {
            e.stopPropagation();
            player.skipNext();
          }}
        >
          <Icon name="next" size={22} />
        </button>
      </div>
    </>
  );
}
