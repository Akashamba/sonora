import { useCallback, useState, type ReactNode } from "react";
import { AboutModal } from "./components/AboutModal";
import { Nav } from "./components/Nav";
import { AppContext, type AppState } from "./context";
import { useNav, type PageId } from "./hooks/useNav";
import { usePlayer } from "./hooks/usePlayer";
import { useQueue } from "./hooks/useQueue";
import { AlbumDetailPage } from "./pages/AlbumDetailPage";
import { AlbumsPage } from "./pages/AlbumsPage";
import { ArtistDetailPage } from "./pages/ArtistDetailPage";
import { ArtistsPage } from "./pages/ArtistsPage";
import { ImportPage } from "./pages/ImportPage";
import { LibraryPage } from "./pages/LibraryPage";
import { PlayerPage } from "./pages/PlayerPage";
import { QueuePage } from "./pages/QueuePage";
import { SongsPage } from "./pages/SongsPage";
import { PlaylistsPage } from "./pages/PlaylistsPage";
import { PlayerDock } from "./components/PlayerDock";
import type { AlbumItem, AppConfig, ArtistItem } from "./lib/types";

// Each page stays mounted and is only hidden, so scroll position, search text and loaded data survive tab switches.
function Page({
  id,
  active,
  children,
}: {
  id: PageId;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div data-page={id} className={active ? "block" : "hidden"}>
      {children}
    </div>
  );
}

export function App({ config }: { config: AppConfig }) {
  const nav = useNav();
  const { go, page } = nav;
  const queue = useQueue();
  const player = usePlayer(nav, queue);

  const [selectedAlbum, setSelectedAlbum] = useState<AlbumItem | null>(null);
  const [selectedArtist, setSelectedArtist] = useState<ArtistItem | null>(null);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(
    null,
  );
  const [songsVersion, setSongsVersion] = useState(0);

  const openAlbum = useCallback(
    (album: AlbumItem) => {
      setSelectedAlbum(album);
      go("album-detail-page", "albums-page");
    },
    [go],
  );

  const openArtist = useCallback(
    (artist: ArtistItem) => {
      setSelectedArtist(artist);
      go("artist-detail-page", "artists-page");
    },
    [go],
  );

  const openPlaylist = useCallback(
    (id: string | null) => {
      setSelectedPlaylistId(id);
      go("playlists-page", "playlists-page");
    },
    [go],
  );

  const openQueue = useCallback(() => {
    go("queue-page", "player-page");
    queue.load();
  }, [go, queue.load]);

  const reloadSongs = useCallback(() => setSongsVersion((v) => v + 1), []);

  const value: AppState = {
    config,
    nav,
    queue,
    player,
    selectedAlbum,
    selectedArtist,
    selectedPlaylistId,
    songsVersion,
    openAlbum,
    openArtist,
    openPlaylist,
    openQueue,
    reloadSongs,
  };

  return (
    <AppContext.Provider value={value}>
      <AboutModal initiallyOpen={config.SHOW_MODAL} />
      <audio ref={player.audioRef} className="hidden" />
      <div className="app-shell">
        <Nav />
        <main className="app-main mx-auto w-full max-w-[960px] flex-1 px-6 py-8">
          <Page id="songs-page" active={page === "songs-page"}>
            <SongsPage />
          </Page>
          <Page id="albums-page" active={page === "albums-page"}>
            <AlbumsPage active={page === "albums-page"} />
          </Page>
          <Page id="artists-page" active={page === "artists-page"}>
            <ArtistsPage active={page === "artists-page"} />
          </Page>
          <Page id="import-page" active={page === "import-page"}>
            <ImportPage />
          </Page>
          <Page id="album-detail-page" active={page === "album-detail-page"}>
            <AlbumDetailPage />
          </Page>
          <Page id="artist-detail-page" active={page === "artist-detail-page"}>
            <ArtistDetailPage />
          </Page>
          <Page id="queue-page" active={page === "queue-page"}>
            <QueuePage />
          </Page>
          <Page id="playlists-page" active={page === "playlists-page"}>
            <PlaylistsPage />
          </Page>
          <Page id="library-page" active={page === "library-page"}>
            <LibraryPage />
          </Page>
          <PlayerPage active={page === "player-page"} />
        </main>
        <PlayerDock />
      </div>
    </AppContext.Provider>
  );
}
