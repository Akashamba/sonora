import type { CSSProperties } from "react";
import { useCallback, useRef, useState } from "react";
import { BackButton } from "../components/BackButton";
import { ProgressBar } from "../components/ProgressBar";
import { useApp } from "../context";
import { artistCredit, fmt } from "../lib/format";
import { Icon } from "../components/Icon";
import { FloatingMenu } from "../components/FloatingMenu";

// Full-screen Now Playing. The artwork is the hero, with the blurred cover behind it.
export function PlayerPage({ active }: { active: boolean }) {
  const { player, openQueue, openAlbum, openArtist } = useApp();
  const { track, liked, cover, playing } = player;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const album = track?.release_group;
  const artist = track?.artists?.[0];

  return (
    <div
      className={`${active ? "flex" : "hidden"} player-fullscreen np-page`}
      style={
        { "--player-bg": cover ? `url("${cover}")` : "none" } as CSSProperties
      }
    >
      <BackButton />
      <div className="np-art">
        {cover ? <img src={cover} alt="" /> : <Icon name="note" size={64} />}
      </div>

      <div className="np-info">
        <div className="np-copy">
          <div className="np-title">{track?.title ?? "—"}</div>
          <div className="np-artist">
            {track ? artistCredit(track.artists) : "—"}
          </div>
        </div>
        {track && (
          <button
            className={`np-icon ${liked ? "liked" : ""}`}
            aria-label="Like"
            onClick={player.toggleLike}
          >
            <Icon name={liked ? "heart" : "heartOutline"} size={22} />
          </button>
        )}
        {track && (
          <div className="track-menu-wrap">
            <button
              ref={menuButtonRef}
              className="np-icon"
              aria-label="More options"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Icon name="more" size={22} />
            </button>
            {menuOpen && (
              <FloatingMenu anchorRef={menuButtonRef} onClose={closeMenu}>
                {artist?.id && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      openArtist({ id: artist.id!, name: artist.name });
                    }}
                  >
                    Go to artist
                  </button>
                )}
                {album?.id && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      openAlbum({
                        id: album.id!,
                        title: album.title ?? "",
                        cover_art_url: album.cover_art_url ?? null,
                      });
                    }}
                  >
                    Go to album
                  </button>
                )}
              </FloatingMenu>
            )}
          </div>
        )}
      </div>

      <div className="np-progress">
        <ProgressBar
          resetKey={track?.id ?? null}
          total={track ? fmt(track.length) : "0:00"}
          remaining
        />
      </div>

      <div className="np-controls">
        <button
          className="np-skip"
          title="-10s"
          aria-label="Back 10 seconds"
          onClick={() => player.seekRelative(-10)}
        >
          <Icon name="replay10" size={22} />
        </button>
        <button
          className="np-side"
          title="Prev"
          aria-label="Previous track"
          onClick={player.skipPrevious}
        >
          <Icon name="prev" size={30} />
        </button>
        <button
          className="np-play"
          aria-label={playing ? "Pause" : "Play"}
          onClick={player.togglePlayPause}
        >
          <Icon name={playing ? "pause" : "play"} size={30} />
        </button>
        <button
          className="np-side"
          title="Next"
          aria-label="Next track"
          onClick={player.skipNext}
        >
          <Icon name="next" size={30} />
        </button>
        <button
          className="np-skip"
          title="+10s"
          aria-label="Forward 10 seconds"
          onClick={() => player.seekRelative(10)}
        >
          <Icon name="forward10" size={22} />
        </button>
      </div>

      <div className="np-volume">
        <Icon name="volumeLow" size={18} />
        <input
          aria-label="Volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={player.volume}
          onChange={(e) => player.setVolume(Number(e.target.value))}
        />
        <Icon name="volumeHigh" size={18} />
      </div>

      <div className="np-footer">
        <button onClick={openQueue}>Up Next</button>
      </div>
    </div>
  );
}
