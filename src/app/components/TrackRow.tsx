import { useApp } from "../context";
import { Icon } from "./Icon";
import { FloatingMenu } from "./FloatingMenu";
import { CoverImage } from "./CoverImage";
import { useCallback, useRef, useState } from "react";
import {
  ENDPOINTS,
  apiFetch,
  apiRequest,
  postQueue,
  queueFailure,
} from "../lib/api";
import { artistCredit, fmt } from "../lib/format";
import type { TrackItem } from "../lib/types";
import {
  itemDuration,
  itemInfo,
  itemMeta,
  itemRight,
  itemThumb,
  itemTitle,
  listItem,
  playBtn,
} from "../lib/styles";

// One track row. `index` replaces the thumbnail with a number when the track has no cover art.
// `onPlay` replaces the default "play this one track" (album and playlist rows play from their
// position onward). `playable={false}` turns off tap-to-play, for rows that cannot be played yet.
export function TrackRow({
  track,
  index,
  onPlay,
  playable = true,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  track: TrackItem;
  index?: number;
  onPlay?: () => void;
  playable?: boolean;
  onRemove?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const { player, queue, openAlbum, openArtist } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [playlists, setPlaylists] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [menuMessage, setMenuMessage] = useState("");
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const credit = artistCredit(track.artists);
  const album = track.release_group?.title ?? "";
  const meta = [credit, album].filter(Boolean).join(" · ");
  const thumb = track.release_group?.cover_art_url_thumbnail_small;

  const openMenu = async () => {
    setMenuOpen((open) => !open);
    setMenuMessage("");
    try {
      const res = await apiFetch<{ data?: { id: string; name: string }[] }>(
        ENDPOINTS.playlists(),
      );
      setPlaylists(res.data ?? []);
    } catch {
      setPlaylists([]);
      setMenuMessage("Playlists are unavailable.");
    }
  };

  const numbered = index !== undefined;
  const artistId = track.artists?.[0]?.id;
  const albumId = track.release_group?.id;
  const play = onPlay ?? (() => player.playFromList(track));

  return (
    <div
      className={`${listItem} song-row ${numbered ? "numbered-row" : ""}`}
      onClick={numbered && playable ? play : undefined}
    >
      {index !== undefined ? (
        <div className={`${itemThumb} track-number`}>{index + 1}</div>
      ) : (
        <CoverImage
          src={thumb}
          className={itemThumb}
          fallback={
            <div className={itemThumb}>
              <Icon name="note" size={18} />
            </div>
          }
        />
      )}
      <div className={`${itemInfo} song-columns`}>
        <div className={itemTitle}>{track.title}</div>
        <div className={itemMeta}>{credit || "Unknown artist"}</div>
        <div className="song-album">{album || "—"}</div>
      </div>
      <div className={itemRight}>
        <span className={`${itemDuration} item-duration`}>
          {fmt(track.length)}
        </span>
        {playable && (
          <button
            className={playBtn}
            title="Play"
            onClick={(e) => {
              e.stopPropagation();
              play();
            }}
          >
            <Icon name="play" size={12} />
          </button>
        )}
        <div className="track-menu-wrap" onClick={(e) => e.stopPropagation()}>
          <button
            ref={menuButtonRef}
            className="track-menu-button"
            title="More options"
            aria-label={`More options for ${track.title}`}
            onClick={openMenu}
          >
            •••
          </button>
          {menuOpen && (
            <FloatingMenu anchorRef={menuButtonRef} onClose={closeMenu}>
              {artistId && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    openArtist({
                      id: artistId,
                      name: track.artists?.[0]?.name ?? credit,
                    });
                  }}
                >
                  Go to artist
                </button>
              )}
              {albumId && !numbered && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    openAlbum({
                      id: albumId,
                      title: album,
                      cover_art_url: track.release_group?.cover_art_url ?? null,
                    });
                  }}
                >
                  Go to album
                </button>
              )}
              <button
                onClick={async () => {
                  try {
                    await postQueue(ENDPOINTS.queueTracks(), {
                      trackIds: [track.id],
                    });
                    // Only adds to the top of the queue. The song playing now keeps playing.
                    queue.load();
                    setMenuMessage("Will play next");
                  } catch (e) {
                    setMenuMessage(queueFailure(e));
                  }
                }}
              >
                Play next
              </button>
              {onRemove && (
                <button
                  onClick={() => {
                    onRemove();
                    setMenuOpen(false);
                  }}
                >
                  Remove from playlist
                </button>
              )}
              {onMoveUp && (
                <button
                  onClick={() => {
                    onMoveUp();
                    setMenuOpen(false);
                  }}
                >
                  Move up
                </button>
              )}
              {onMoveDown && (
                <button
                  onClick={() => {
                    onMoveDown();
                    setMenuOpen(false);
                  }}
                >
                  Move down
                </button>
              )}
              <div className="popover-label">Add to playlist</div>
              {playlists.map((playlist) => (
                <button
                  key={playlist.id}
                  onClick={async () => {
                    try {
                      await apiRequest(ENDPOINTS.playlistTracks(playlist.id), {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ trackIds: [track.id] }),
                      });
                      setMenuMessage(`Added to ${playlist.name}`);
                      window.dispatchEvent(
                        new Event("sonora:playlists-updated"),
                      );
                    } catch {
                      setMenuMessage("Could not add track.");
                    }
                  }}
                >
                  {playlist.name}
                </button>
              ))}
              {menuMessage && (
                <span className="popover-message">{menuMessage}</span>
              )}
            </FloatingMenu>
          )}
        </div>
      </div>
    </div>
  );
}
