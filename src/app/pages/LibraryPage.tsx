import { useCallback, useEffect, useState } from "react";
import { useApp } from "../context";
import { ENDPOINTS, apiFetch } from "../lib/api";
import { Icon } from "../components/Icon";
import type { Tab } from "../hooks/useNav";

interface PlaylistBrief {
  id: string;
  name: string;
}

// Mobile-only hub for the library sections that the sidebar shows on desktop.
export function LibraryPage() {
  const { nav, openPlaylist } = useApp();
  const [playlists, setPlaylists] = useState<PlaylistBrief[]>([]);

  const loadPlaylists = useCallback(() => {
    apiFetch<{ data?: PlaylistBrief[] }>(ENDPOINTS.playlists())
      .then((res) => setPlaylists(res.data ?? []))
      .catch(() => setPlaylists([]));
  }, []);

  useEffect(() => {
    loadPlaylists();
    window.addEventListener("sonora:playlists-updated", loadPlaylists);
    return () =>
      window.removeEventListener("sonora:playlists-updated", loadPlaylists);
  }, [loadPlaylists]);

  const sections: { tab: Tab; label: string }[] = [
    { tab: "songs", label: "Recently Added" },
    { tab: "artists", label: "Artists" },
    { tab: "albums", label: "Albums" },
  ];

  return (
    <div className="library-hub">
      <p className="eyebrow">Library</p>
      <h1 className="page-hero-title">Library</h1>
      <div className="hub-list">
        {sections.map((s) => (
          <button
            key={s.tab}
            className="hub-row"
            onClick={() => nav.showTab(s.tab)}
          >
            {s.label}
            <Icon name="chevron" size={20} />
          </button>
        ))}
      </div>
      <div className="hub-heading">
        <span className="eyebrow">Playlists</span>
        <button className="text-button" onClick={() => openPlaylist(null)}>
          New Playlist
        </button>
      </div>
      <div className="hub-list">
        {playlists.length === 0 && (
          <p className="empty-state">No playlists yet.</p>
        )}
        {playlists.map((p) => (
          <button
            key={p.id}
            className="hub-row"
            onClick={() => openPlaylist(p.id)}
          >
            {p.name}
            <Icon name="chevron" size={20} />
          </button>
        ))}
      </div>
    </div>
  );
}
