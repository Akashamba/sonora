import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../context";
import { BackButton } from "../components/BackButton";
import { FloatingMenu } from "../components/FloatingMenu";
import { Icon } from "../components/Icon";
import { PlaylistMosaic } from "../components/PlaylistMosaic";
import { TrackRow } from "../components/TrackRow";
import {
  ENDPOINTS,
  apiFetch,
  apiRequest,
  errorMessage,
  postQueue,
} from "../lib/api";
import { artistCredit } from "../lib/format";
import type { TrackItem } from "../lib/types";

type Playlist = {
  id: string;
  name: string;
  description: string | null;
  sourceUrl?: string | null;
  trackCount: number;
  durationMs: number;
  coverArtUrls: string[];
  createdAt: number;
  updatedAt: number;
};
type Entry = {
  entryId: string;
  position: number;
  addedAt: number;
  track: TrackItem;
};
type PlaylistDetail = Playlist & { tracks: Entry[] };

export function PlaylistsPage() {
  const { selectedPlaylistId, openPlaylist, player, nav } = useApp();
  const [items, setItems] = useState<Playlist[]>([]);
  const [detail, setDetail] = useState<PlaylistDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The create card and the detail editor each get their own fields, so a name typed
  // for one playlist never shows up in the create form.
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const loadList = useCallback(async () => {
    try {
      const res = await apiFetch<{ data?: Playlist[] }>(ENDPOINTS.playlists());
      setItems(res.data ?? []);
      setError("");
    } catch (e) {
      setItems([]);
      setError(`Playlists are unavailable: ${errorMessage(e)}`);
    }
  }, []);
  const loadDetail = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const res = await apiFetch<{ data: PlaylistDetail }>(
        ENDPOINTS.playlist(id),
      );
      // The rename draft (name, description) is not touched here, so a refresh after a
      // track removal does not clobber an edit in progress.
      setDetail(res.data);
      setError("");
    } catch (e) {
      setDetail(null);
      setError(`Could not load this playlist: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    setEditing(false);
    if (selectedPlaylistId) void loadDetail(selectedPlaylistId);
    else setDetail(null);
  }, [selectedPlaylistId, loadDetail]);

  const create = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const res = await apiRequest(ENDPOINTS.playlists(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          description: newDescription.trim() || undefined,
        }),
      });
      const result = (await res.json()) as { data: Playlist };
      setNewName("");
      setNewDescription("");
      window.dispatchEvent(new Event("sonora:playlists-updated"));
      await loadList();
      openPlaylist(result.data.id);
    } catch (e) {
      setError(`Could not create playlist: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!detail) return;
    try {
      await apiRequest(ENDPOINTS.playlist(detail.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description }),
      });
      setEditing(false);
      window.dispatchEvent(new Event("sonora:playlists-updated"));
      await loadList();
      await loadDetail(detail.id);
    } catch (e) {
      setError(`Could not update playlist: ${errorMessage(e)}`);
    }
  };
  const removePlaylist = async () => {
    if (!detail || !confirm(`Delete “${detail.name}”?`)) return;
    try {
      await apiRequest(ENDPOINTS.playlist(detail.id), { method: "DELETE" });
      window.dispatchEvent(new Event("sonora:playlists-updated"));
      await loadList();
      openPlaylist(null);
    } catch (e) {
      setError(`Could not delete playlist: ${errorMessage(e)}`);
    }
  };
  const queuePlaylist = async () => {
    if (!detail) return;
    try {
      await apiRequest(ENDPOINTS.playlistQueue(detail.id), { method: "POST" });
    } catch (e) {
      setError(`Could not queue playlist: ${errorMessage(e)}`);
    }
  };
  // Play and Shuffle put the whole playlist in the server queue, then play from it.
  const playPlaylist = async (shuffle: boolean) => {
    if (!detail) return;
    // Must run before the await, while the tap still counts as a user gesture.
    player.unlockAudio();
    try {
      await postQueue(ENDPOINTS.playlistQueue(detail.id, shuffle));
      await player.playFromQueue();
    } catch (e) {
      setError(
        `Could not ${shuffle ? "shuffle" : "play"} playlist: ${errorMessage(e)}`,
      );
    }
  };
  // A row plays that song, then the rest of the playlist in order.
  const playFrom = (index: number) => {
    const ids = detail?.tracks.slice(index).map((e) => e.track.id) ?? [];
    if (ids.length === 0) return;
    player.playTracksNow(ids).catch((e: unknown) => {
      setError(`Could not play playlist: ${errorMessage(e)}`);
    });
  };
  const move = async (index: number, targetIndex: number) => {
    if (!detail || targetIndex < 0 || targetIndex >= detail.tracks.length)
      return;
    const entries = [...detail.tracks];
    const [entry] = entries.splice(index, 1);
    if (!entry) return;
    entries.splice(targetIndex, 0, entry);
    setDetail({ ...detail, tracks: entries });
    const afterEntryId =
      targetIndex === 0 ? null : (entries[targetIndex - 1]?.entryId ?? null);
    try {
      await apiRequest(ENDPOINTS.playlistTrack(detail.id, entry.entryId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ afterEntryId }),
      });
    } catch (e) {
      setError(`Could not reorder playlist: ${errorMessage(e)}`);
      await loadDetail(detail.id);
    }
  };
  const removeEntry = async (entryId: string) => {
    if (!detail) return;
    try {
      await apiRequest(ENDPOINTS.playlistTrack(detail.id, entryId), {
        method: "DELETE",
      });
      await loadDetail(detail.id);
    } catch (e) {
      setError(`Could not remove track: ${errorMessage(e)}`);
    }
  };

  return (
    <section
      className={`music-page playlist-page ${detail ? "detail-page" : ""}`}
    >
      {!detail && (
        <>
          <header className="page-heading">
            <div>
              <p className="eyebrow">Your collection</p>
              <h1>Playlists</h1>
            </div>
          </header>
          <div className="library-shortcuts">
            <button onClick={() => nav.showTab("songs")}>Recently Added</button>
            <button onClick={() => nav.showTab("artists")}>Artists</button>
            <button onClick={() => nav.showTab("albums")}>Albums</button>
            <button onClick={() => nav.showTab("songs")}>Songs</button>
          </div>
        </>
      )}
      {error && <div className="notice error-notice">{error}</div>}
      {!selectedPlaylistId ? (
        <>
          <div className="create-playlist-card">
            <div>
              <h2>Create a playlist</h2>
              <p>Make a collection for every mood.</p>
            </div>
            <div className="create-fields">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Playlist name"
                aria-label="Playlist name"
              />
              <input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Description (optional)"
                aria-label="Description"
              />
              <button
                className="pill-button red"
                disabled={busy || !newName.trim()}
                onClick={() => void create()}
              >
                Create
              </button>
            </div>
          </div>
          {items.length ? (
            <div className="cover-grid playlist-grid">
              {items.map((playlist) => (
                <button
                  className="cover-card playlist-card"
                  key={playlist.id}
                  onClick={() => openPlaylist(playlist.id)}
                >
                  <PlaylistMosaic covers={playlist.coverArtUrls} />
                  <strong>{playlist.name}</strong>
                  <small>{playlist.trackCount} songs</small>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              {error
                ? "Playlists will appear here when the playlist API is available."
                : "Your playlists will appear here."}
            </div>
          )}
        </>
      ) : busy && !detail ? (
        <div className="empty-state">Loading playlist…</div>
      ) : (
        detail && (
          <>
            <BackButton />
            {detail.coverArtUrls[0] && (
              <div
                className="detail-tint"
                aria-hidden
                style={{ backgroundImage: `url("${detail.coverArtUrls[0]}")` }}
              />
            )}
            <div className="playlist-hero">
              <PlaylistMosaic
                covers={detail.coverArtUrls}
                className="hero-mosaic"
                noteSize={56}
              />
              <div className="playlist-info">
                <p className="eyebrow">Playlist</p>
                {editing ? (
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-label="Playlist name"
                  />
                ) : (
                  <h2>{detail.name}</h2>
                )}
                {editing ? (
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Description"
                  />
                ) : (
                  <p>{detail.description || `${detail.trackCount} songs`}</p>
                )}
                <div className="detail-actions playlist-actions">
                  <button
                    className="round-btn"
                    aria-label="Shuffle"
                    title="Shuffle"
                    disabled={!detail.tracks.length}
                    onClick={() => void playPlaylist(true)}
                  >
                    <Icon name="shuffle" size={20} />
                  </button>
                  {editing ? (
                    <button className="pill-wide" onClick={() => void save()}>
                      Save
                    </button>
                  ) : (
                    <button
                      className="pill-wide"
                      disabled={!detail.tracks.length}
                      onClick={() => void playPlaylist(false)}
                    >
                      <Icon name="play" size={18} /> Play
                    </button>
                  )}
                  <div className="track-menu-wrap">
                    <button
                      ref={menuButtonRef}
                      className="round-btn"
                      aria-label="More options"
                      title="More options"
                      onClick={() => setMenuOpen((open) => !open)}
                    >
                      <Icon name="more" size={22} />
                    </button>
                    {menuOpen && (
                      <FloatingMenu
                        anchorRef={menuButtonRef}
                        onClose={closeMenu}
                        className="playlist-menu"
                      >
                        <button
                          onClick={() => {
                            setMenuOpen(false);
                            void queuePlaylist();
                          }}
                        >
                          Add to Queue
                        </button>
                        <button
                          onClick={() => {
                            setMenuOpen(false);
                            // The draft starts from the saved values and is kept apart from the fetched data.
                            setName(detail.name);
                            setDescription(detail.description ?? "");
                            setEditing(true);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          className="danger-item"
                          onClick={() => {
                            setMenuOpen(false);
                            void removePlaylist();
                          }}
                        >
                          Delete playlist
                        </button>
                      </FloatingMenu>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div className="track-list">
              {detail.tracks.map((entry, index) => (
                <TrackRow
                  key={entry.entryId}
                  track={entry.track}
                  index={index}
                  onPlay={() => playFrom(index)}
                  onRemove={() => void removeEntry(entry.entryId)}
                  onMoveUp={
                    index > 0 ? () => void move(index, index - 1) : undefined
                  }
                  onMoveDown={
                    index < detail.tracks.length - 1
                      ? () => void move(index, index + 1)
                      : undefined
                  }
                />
              ))}
            </div>
            {!detail.tracks.length && (
              <div className="empty-state">
                This playlist is empty. Use a song’s ••• menu to add tracks.
              </div>
            )}
          </>
        )
      )}
    </section>
  );
}
