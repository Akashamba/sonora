import { fmtDate } from "../lib/format";
import type { AlbumItem } from "../lib/types";
import { useApp } from "../context";
import { ENDPOINTS, apiFetch, errorMessage } from "../lib/api";
import type { TrackItem } from "../lib/types";
import { Icon } from "./Icon";
import { CoverImage } from "./CoverImage";

// One album in the library grid: square artwork, title, then type and year.
// Play and Shuffle sit over the artwork and queue the album's tracks.
export function AlbumRow({ album }: { album: AlbumItem }) {
  const { openAlbum, player } = useApp();
  const playAlbum = async (shuffle: boolean) => {
    // Must run before the fetch below, while the tap still counts as a user gesture.
    player.unlockAudio();
    try {
      const res = await apiFetch<{ data: { tracks?: TrackItem[] } }>(
        ENDPOINTS.albumTracks(album.id),
      );
      const ids = (res.data.tracks ?? []).map((t) => t.id);
      if (ids.length) await player.playTracksNow(ids, shuffle);
    } catch (e) {
      alert(`Could not play album: ${errorMessage(e)}`);
    }
  };
  const thumb = album.cover_art_url_thumbnail_small ?? album.cover_art_url;
  const year = fmtDate(album.first_release_date);
  const meta = [album.musicbrainz_primary_type, year !== "—" ? year : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="cover-card"
      role="button"
      tabIndex={0}
      onClick={() => openAlbum(album)}
      onKeyDown={(e) => {
        if (e.key === "Enter") openAlbum(album);
      }}
    >
      <span className="cover-art">
        <CoverImage
          src={thumb}
          loading="lazy"
          fallback={<Icon name="disc" size={36} />}
        />
        <span
          className="cover-actions"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <button className="cover-pill" onClick={() => void playAlbum(false)}>
            <Icon name="play" size={12} /> Play
          </button>
          <button className="cover-pill" onClick={() => void playAlbum(true)}>
            <Icon name="shuffle" size={12} /> Shuffle
          </button>
        </span>
      </span>
      <span className="cover-title">{album.title}</span>
      <span className="cover-meta">{meta || "Album"}</span>
    </div>
  );
}
