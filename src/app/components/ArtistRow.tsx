import { useApp } from "../context";
import type { ArtistItem } from "../lib/types";
import { Icon } from "./Icon";

// One artist in the library grid. Artists have no artwork, so the first letter stands in for it.
export function ArtistRow({ artist }: { artist: ArtistItem }) {
  const { openArtist } = useApp();
  return (
    <div
      className="cover-card artist-card"
      role="button"
      tabIndex={0}
      onClick={() => openArtist(artist)}
      onKeyDown={(e) => {
        if (e.key === "Enter") openArtist(artist);
      }}
    >
      <span className="cover-art">{artist.name.charAt(0).toUpperCase()}</span>
      <span className="cover-title">{artist.name}</span>
      <Icon name="chevron" size={20} className="artist-chevron" />
    </div>
  );
}
