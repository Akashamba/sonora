import { useEffect, useState } from "react";
import { BackButton } from "../components/BackButton";
import { TrackRow } from "../components/TrackRow";
import { useApp } from "../context";
import {
  ENDPOINTS,
  apiFetch,
  apiRequest,
  errorMessage,
  postQueue,
  queueFailure,
} from "../lib/api";
import { artistCredit, fmtDate } from "../lib/format";
import { list, stateError, stateMsg } from "../lib/styles";
import { Icon } from "../components/Icon";
import type { TrackItem } from "../lib/types";

// The server returns album order and, when known, the MusicBrainz track number.
type AlbumTrack = TrackItem & { track_number?: number | null };

interface AlbumTracksResponse {
  data: { tracks?: AlbumTrack[] };
}

interface PlaylistBrief {
  id: string;
  name: string;
}

export function AlbumDetailPage() {
  const { selectedAlbum: album, queue, player } = useApp();
  const [tracks, setTracks] = useState<AlbumTrack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queueLabel, setQueueLabel] = useState("Queue album");
  const [menuOpen, setMenuOpen] = useState(false);
  const [playlists, setPlaylists] = useState<PlaylistBrief[]>([]);
  const [message, setMessage] = useState("");
  // Cover art comes from an external host. When it fails to load, show the placeholder instead.
  const [coverBroken, setCoverBroken] = useState(false);

  // Each opened album loads its own track list.
  useEffect(() => {
    if (!album) return;
    let cancelled = false;
    setTracks(null);
    setError(null);
    setQueueLabel("Queue album");
    setMenuOpen(false);
    setMessage("");
    setCoverBroken(false);
    apiFetch<AlbumTracksResponse>(ENDPOINTS.albumTracks(album.id))
      .then((res) => {
        if (!cancelled) setTracks(res.data.tracks ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [album]);

  // The cover can be missing on the album row; any track's release group has the same art.
  const cover =
    album?.cover_art_url ?? tracks?.[0]?.release_group?.cover_art_url ?? null;
  const artist = tracks?.[0] ? artistCredit(tracks[0].artists) : "";
  const playable = (tracks ?? []).length > 0;

  const queueAlbum = async () => {
    if (!album) return;
    setQueueLabel("Queuing…");
    try {
      await apiRequest(ENDPOINTS.queueAlbum(album.id), { method: "POST" });
      setQueueLabel("Queued");
      queue.load();
    } catch (e) {
      if (errorMessage(e) === "403") {
        setQueueLabel("Demo mode");
        alert("Queueing is disabled in demo mode.");
      } else {
        setQueueLabel("Error");
      }
    }
    setTimeout(() => setQueueLabel("Queue album"), 1000);
  };

  const toggleMenu = async () => {
    const next = !menuOpen;
    setMenuOpen(next);
    setMessage("");
    if (!next) return;
    try {
      const res = await apiFetch<{ data?: PlaylistBrief[] }>(
        ENDPOINTS.playlists(),
      );
      setPlaylists(res.data ?? []);
    } catch {
      setPlaylists([]);
      setMessage("Playlists are unavailable.");
    }
  };

  // Adds every track of the album to one playlist, in album order.
  const addAlbumTo = async (playlist: PlaylistBrief) => {
    if (!tracks?.length) return;
    try {
      await apiRequest(ENDPOINTS.playlistTracks(playlist.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackIds: tracks.map((t) => t.id) }),
      });
      setMessage(`Added to ${playlist.name}`);
      window.dispatchEvent(new Event("sonora:playlists-updated"));
    } catch {
      setMessage("Could not add album.");
    }
  };

  // Play and Shuffle put the whole album in the server queue, then play from it. The queue keeps
  // the album order (or shuffles it), so each song advances to the next one.
  const playAlbum = async (shuffle: boolean) => {
    if (!album) return;
    // Must run before the await, while the tap still counts as a user gesture.
    player.unlockAudio();
    try {
      await postQueue(ENDPOINTS.queueAlbum(album.id, shuffle));
      await player.playFromQueue();
    } catch (e) {
      alert(queueFailure(e));
    }
  };

  // A row plays that song, then the rest of the album in order.
  const playFrom = (index: number) => {
    const ids = tracks?.slice(index).map((t) => t.id) ?? [];
    if (ids.length === 0) return;
    player.playTracksNow(ids).catch((e: unknown) => alert(queueFailure(e)));
  };

  return (
    <div className="detail-page">
      {cover && (
        <div
          className="detail-tint"
          aria-hidden
          style={{ backgroundImage: `url("${cover}")` }}
        />
      )}
      <BackButton />
      <header className="detail-hero">
        <div className="detail-art">
          {cover && !coverBroken ? (
            <img src={cover} alt="" onError={() => setCoverBroken(true)} />
          ) : (
            <Icon name="disc" size={56} />
          )}
        </div>
        <h1 className="detail-title">{album?.title ?? "—"}</h1>
        {artist && <div className="detail-artist">{artist}</div>}
        <div className="detail-meta">
          {album?.musicbrainz_primary_type ?? "Album"} ·{" "}
          {fmtDate(album?.first_release_date)}
          {tracks ? ` · ${tracks.length} songs` : ""}
        </div>
        <div className="detail-actions">
          <button
            className="round-btn"
            aria-label="Shuffle"
            title="Shuffle"
            disabled={!playable}
            onClick={() => void playAlbum(true)}
          >
            <Icon name="shuffle" size={20} />
          </button>
          <button
            className="pill-wide"
            disabled={!playable}
            onClick={() => void playAlbum(false)}
          >
            <Icon name="play" size={18} /> Play
          </button>
          <button
            className="round-btn"
            aria-label="Add album to playlist"
            title="Add to playlist"
            disabled={!playable}
            onClick={toggleMenu}
          >
            <Icon name="plus" size={22} />
          </button>
        </div>
        {menuOpen && (
          <div className="album-add-menu">
            {playlists.length === 0 && (
              <span className="popover-message">No playlists yet.</span>
            )}
            {playlists.map((p) => (
              <button key={p.id} onClick={() => void addAlbumTo(p)}>
                {p.name}
              </button>
            ))}
            {message && <span className="popover-message">{message}</span>}
          </div>
        )}
        <button className="text-button detail-queue" onClick={queueAlbum}>
          {queueLabel}
        </button>
      </header>
      <div className={`${list} detail-tracks`}>
        {error ? (
          <div className={`${stateMsg} ${stateError}`}>
            Failed to load: {error}
          </div>
        ) : tracks === null ? (
          <div className={stateMsg}>Loading tracks…</div>
        ) : tracks.length === 0 ? (
          <div className={stateMsg}>No tracks found.</div>
        ) : (
          album &&
          tracks.map((t, i) => (
            <TrackRow
              key={t.id}
              // TrackRow shows index + 1, so pass track_number - 1 when it is known.
              index={t.track_number != null ? t.track_number - 1 : i}
              onPlay={() => playFrom(i)}
              track={{
                ...t,
                release_group: {
                  id: album.id,
                  title: album.title,
                  cover_art_url: cover,
                },
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}
