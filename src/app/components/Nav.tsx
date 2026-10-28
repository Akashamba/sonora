import { useEffect, useState } from "react";
import { useApp } from "../context";
import { ENDPOINTS, apiFetch } from "../lib/api";
import type { Tab } from "../hooks/useNav";
import { Icon, type IconName } from "./Icon";
import { PlaylistMosaic } from "./PlaylistMosaic";

interface PlaylistBrief {
  id: string;
  name: string;
  coverArtUrls?: string[];
}

export function Nav() {
  const { nav, openPlaylist } = useApp();
  const [playlists, setPlaylists] = useState<PlaylistBrief[]>([]);
  const [query, setQuery] = useState("");
  const loadPlaylists = () =>
    apiFetch<{ data?: PlaylistBrief[] }>(ENDPOINTS.playlists())
      .then((res) => setPlaylists(res.data ?? []))
      .catch(() => setPlaylists([]));

  useEffect(() => {
    void loadPlaylists();
    const refresh = () => void loadPlaylists();
    window.addEventListener("sonora:playlists-updated", refresh);
    return () =>
      window.removeEventListener("sonora:playlists-updated", refresh);
  }, []);

  const goSearch = () => {
    nav.showTab("songs");
    window.dispatchEvent(new CustomEvent("sonora-search", { detail: query }));
  };

  const sideLink = (
    active: boolean,
    icon: IconName,
    label: string,
    onClick: () => void,
  ) => (
    <button className={`side-link ${active ? "active" : ""}`} onClick={onClick}>
      <Icon name={icon} size={18} />
      {label}
    </button>
  );

  const mobileTab = (tab: Tab, label: string, icon: IconName) => (
    <button
      className={nav.tab === tab ? "mobile-tab active" : "mobile-tab"}
      onClick={() => nav.showTab(tab)}
      key={tab}
    >
      <Icon name={icon} size={22} />
      {label}
    </button>
  );

  return (
    <>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          sonora
        </div>
        <form
          className="sidebar-search"
          onSubmit={(e) => {
            e.preventDefault();
            goSearch();
          }}
        >
          <Icon name="search" size={16} />
          <input
            aria-label="Search"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
        {sideLink(nav.page === "songs-page", "home", "Home", () =>
          nav.showTab("songs"),
        )}
        <div className="side-label">Library</div>
        {sideLink(nav.tab === "songs", "clock", "Recently Added", () =>
          nav.showTab("songs"),
        )}
        {sideLink(nav.tab === "artists", "person", "Artists", () =>
          nav.showTab("artists"),
        )}
        {sideLink(nav.tab === "albums", "disc", "Albums", () =>
          nav.showTab("albums"),
        )}
        {sideLink(false, "note", "Songs", () => nav.showTab("songs"))}
        <div className="side-section-heading">
          <span className="side-label">Playlists</span>
          <button
            title="New Playlist"
            aria-label="New Playlist"
            onClick={() => openPlaylist(null)}
          >
            <Icon name="plus" size={18} />
          </button>
        </div>
        <div className="playlist-nav-list">
          {playlists.map((playlist) => (
            <button
              className="side-link playlist-link"
              key={playlist.id}
              title={playlist.name}
              onClick={() => openPlaylist(playlist.id)}
            >
              <PlaylistMosaic
                covers={playlist.coverArtUrls ?? []}
                className="side-mosaic"
                noteSize={14}
              />
              <span className="playlist-name">{playlist.name}</span>
            </button>
          ))}
        </div>
        <button
          className="new-playlist-link"
          onClick={() => openPlaylist(null)}
        >
          + New Playlist
        </button>
        <div className="sidebar-spacer" />
        {sideLink(nav.tab === "import", "import", "Import", () =>
          nav.showTab("import"),
        )}
      </aside>
      <nav className="mobile-tabs">
        {mobileTab("songs", "Home", "home")}
        <button
          className={
            nav.page === "library-page" ? "mobile-tab active" : "mobile-tab"
          }
          onClick={() => nav.go("library-page")}
        >
          <Icon name="library" size={22} />
          Library
        </button>
        <button className="mobile-tab" onClick={goSearch}>
          <Icon name="search" size={22} />
          Search
        </button>
        {mobileTab("import", "Import", "import")}
      </nav>
    </>
  );
}
