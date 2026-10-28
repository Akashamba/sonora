import { createContext, useContext } from "react";
import type { Nav } from "./hooks/useNav";
import type { Player } from "./hooks/usePlayer";
import type { Queue } from "./hooks/useQueue";
import type { AlbumItem, AppConfig, ArtistItem } from "./lib/types";

export interface AppState {
  config: AppConfig;
  nav: Nav;
  queue: Queue;
  player: Player;
  selectedAlbum: AlbumItem | null;
  selectedArtist: ArtistItem | null;
  selectedPlaylistId: string | null;
  // Bumped after an import so the songs list reloads.
  songsVersion: number;
  openAlbum: (album: AlbumItem) => void;
  openArtist: (artist: ArtistItem) => void;
  openPlaylist: (id: string | null) => void;
  openQueue: () => void;
  reloadSongs: () => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (!value)
    throw new Error("useApp must be used inside <AppContext.Provider>");
  return value;
}
