import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, X, Clock, TrendingUp } from "lucide-react";
import { Section } from "@/components/Section";
import { MediaCard } from "@/components/MediaCard";
import { TrackRow } from "@/components/TrackRow";
import { usePlayer } from "@/context/PlayerContext";
import {
  allTracks,
  recentAlbums,
  playlists,
  artists,
  recentSearches,
} from "@/data/mockData";
import { cn } from "@/lib/utils";

export function SearchPage() {
  const [query, setQuery] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const { playTrack, currentTrack, isPlaying } = usePlayer();

  const searchResults = useMemo(() => {
    if (!query.trim()) return null;

    const q = query.toLowerCase();

    const tracks = allTracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.album.toLowerCase().includes(q),
    );

    const albums = recentAlbums.filter(
      (a) =>
        a.title.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q),
    );

    const matchedPlaylists = playlists.filter((p) =>
      p.title.toLowerCase().includes(q),
    );

    const matchedArtists = artists.filter((a) =>
      a.name.toLowerCase().includes(q),
    );

    // Top hit - highest confidence result
    const topHit =
      tracks[0] || albums[0] || matchedArtists[0] || matchedPlaylists[0];

    return {
      topHit,
      tracks: tracks.slice(0, 6),
      albums: albums.slice(0, 4),
      playlists: matchedPlaylists.slice(0, 4),
      artists: matchedArtists.slice(0, 4),
    };
  }, [query]);

  const handleRecentSearch = (term: string) => {
    setQuery(term);
  };

  return (
    <motion.div
      className="min-h-screen pb-40"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      {/* Search header */}
      <header className="sticky top-0 z-10 bg-[var(--background)]/80 px-4 py-6 backdrop-blur-xl md:px-8">
        <h1 className="mb-4 text-3xl font-bold text-[var(--foreground)]">
          Search
        </h1>

        {/* Search input */}
        <div
          className={cn(
            "relative flex items-center gap-3 rounded-2xl border px-4 py-3 transition-all",
            isFocused
              ? "border-[var(--accent)] bg-[var(--background-floating)]"
              : "border-[var(--border)] bg-[var(--background-elevated)]",
          )}
          style={{
            boxShadow: isFocused ? "0 0 0 2px var(--accent-glow)" : undefined,
          }}
        >
          <Search className="h-5 w-5 flex-shrink-0 text-[var(--foreground-muted)]" />
          <input
            type="text"
            placeholder="Songs, albums, artists, or playlists"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            className="flex-1 bg-transparent text-[var(--foreground)] placeholder-[var(--foreground-muted)] outline-none"
          />
          <AnimatePresence>
            {query && (
              <motion.button
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--foreground-muted)]"
                onClick={() => setQuery("")}
              >
                <X className="h-3 w-3 text-[var(--background)]" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </header>

      <AnimatePresence mode="wait">
        {!query.trim() ? (
          /* Pre-search state */
          <motion.div
            key="presearch"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            {/* Recent searches */}
            <Section
              title="Recent Searches"
              action={
                <button className="text-sm font-medium text-[var(--accent)]">
                  Clear all
                </button>
              }
            >
              <div className="flex flex-wrap gap-2 px-4">
                {recentSearches.map((term) => (
                  <motion.button
                    key={term}
                    className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--background-elevated)] px-4 py-2 text-sm text-[var(--foreground-secondary)] transition-colors hover:bg-[var(--background-floating)]"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => handleRecentSearch(term)}
                  >
                    <Clock className="h-3 w-3" />
                    {term}
                  </motion.button>
                ))}
              </div>
            </Section>

            {/* Browse categories */}
            <Section title="Browse All">
              <div className="grid grid-cols-2 gap-4 px-4 md:grid-cols-3 lg:grid-cols-4">
                {[
                  { name: "Trending", color: "#EF4444", icon: TrendingUp },
                  { name: "New Releases", color: "#8B5CF6", icon: null },
                  { name: "Podcasts", color: "#10B981", icon: null },
                  { name: "Made for You", color: "#F59E0B", icon: null },
                  { name: "Charts", color: "#3B82F6", icon: null },
                  { name: "Rock", color: "#EC4899", icon: null },
                  { name: "Pop", color: "#14B8A6", icon: null },
                  { name: "Hip-Hop", color: "#6366F1", icon: null },
                ].map((category) => (
                  <motion.button
                    key={category.name}
                    className="relative h-24 overflow-hidden rounded-2xl p-4 text-left"
                    style={{ backgroundColor: category.color }}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <span className="text-lg font-semibold text-white">
                      {category.name}
                    </span>
                    <div
                      className="absolute -bottom-2 -right-2 h-16 w-16 rotate-12 rounded-lg opacity-20"
                      style={{ backgroundColor: "white" }}
                    />
                  </motion.button>
                ))}
              </div>
            </Section>
          </motion.div>
        ) : searchResults ? (
          /* Search results */
          <motion.div
            key="results"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            {/* Top Hit */}
            {searchResults.topHit && (
              <Section title="Top Result">
                <div className="px-4">
                  <motion.div
                    className="flex items-center gap-4 rounded-2xl bg-[var(--background-elevated)] p-4"
                    whileHover={{ scale: 1.01 }}
                  >
                    {"coverUrl" in searchResults.topHit ? (
                      <>
                        <img
                          src={searchResults.topHit.coverUrl}
                          alt=""
                          className="h-24 w-24 rounded-xl object-cover"
                          style={{
                            boxShadow: `0 8px 24px ${"accentColor" in searchResults.topHit ? searchResults.topHit.accentColor : "var(--accent)"}30`,
                          }}
                        />
                        <div>
                          <h3 className="text-2xl font-bold text-[var(--foreground)]">
                            {searchResults.topHit.title}
                          </h3>
                          {"artist" in searchResults.topHit && (
                            <p className="text-[var(--foreground-secondary)]">
                              {searchResults.topHit.artist}
                            </p>
                          )}
                          <span className="mt-2 inline-block rounded-full bg-[var(--background-floating)] px-3 py-1 text-xs font-medium text-[var(--foreground-muted)]">
                            {"duration" in searchResults.topHit
                              ? "Song"
                              : "Album"}
                          </span>
                        </div>
                      </>
                    ) : "imageUrl" in searchResults.topHit ? (
                      <>
                        <img
                          // @ts-ignore
                          src={searchResults.topHit.imageUrl}
                          alt=""
                          className="h-24 w-24 rounded-full object-cover"
                        />
                        <div>
                          <h3 className="text-2xl font-bold text-[var(--foreground)]">
                            {
                              // @ts-ignore
                              searchResults.topHit.name
                            }
                          </h3>
                          <span className="mt-2 inline-block rounded-full bg-[var(--background-floating)] px-3 py-1 text-xs font-medium text-[var(--foreground-muted)]">
                            Artist
                          </span>
                        </div>
                      </>
                    ) : null}
                  </motion.div>
                </div>
              </Section>
            )}

            {/* Songs */}
            {searchResults.tracks.length > 0 && (
              <Section title="Songs">
                <div className="px-4">
                  <div className="rounded-2xl bg-[var(--background-elevated)] p-2">
                    {searchResults.tracks.map((track, index) => (
                      <TrackRow
                        key={track.id}
                        track={track}
                        index={index}
                        onPlay={() => playTrack(track)}
                        isPlaying={isPlaying}
                        isCurrentTrack={currentTrack?.id === track.id}
                      />
                    ))}
                  </div>
                </div>
              </Section>
            )}

            {/* Albums */}
            {searchResults.albums.length > 0 && (
              <Section title="Albums">
                <div className="flex gap-4 overflow-x-auto px-4 pb-4 scrollbar-hide">
                  {searchResults.albums.map((album) => (
                    <MediaCard
                      key={album.id}
                      item={album}
                      type="album"
                      size="md"
                    />
                  ))}
                </div>
              </Section>
            )}

            {/* Playlists */}
            {searchResults.playlists.length > 0 && (
              <Section title="Playlists">
                <div className="flex gap-4 overflow-x-auto px-4 pb-4 scrollbar-hide">
                  {searchResults.playlists.map((playlist) => (
                    <motion.div
                      key={playlist.id}
                      className="w-40 flex-shrink-0 cursor-pointer"
                      whileHover={{ scale: 1.02 }}
                    >
                      <div className="relative h-40 overflow-hidden rounded-2xl">
                        <img
                          src={playlist.coverUrl}
                          alt={playlist.title}
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <h3 className="mt-3 truncate px-1 text-sm font-medium text-[var(--foreground)]">
                        {playlist.title}
                      </h3>
                      <p className="truncate px-1 text-xs text-[var(--foreground-muted)]">
                        {playlist.trackCount} tracks
                      </p>
                    </motion.div>
                  ))}
                </div>
              </Section>
            )}

            {/* Artists */}
            {searchResults.artists.length > 0 && (
              <Section title="Artists">
                <div className="flex gap-4 overflow-x-auto px-4 pb-4 scrollbar-hide">
                  {searchResults.artists.map((artist) => (
                    <motion.div
                      key={artist.id}
                      className="w-36 flex-shrink-0 cursor-pointer text-center"
                      whileHover={{ scale: 1.02 }}
                    >
                      <div className="relative mx-auto h-36 w-36 overflow-hidden rounded-full">
                        <img
                          src={artist.imageUrl}
                          alt={artist.name}
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <h3 className="mt-3 truncate text-sm font-medium text-[var(--foreground)]">
                        {artist.name}
                      </h3>
                      <p className="text-xs text-[var(--foreground-muted)]">
                        Artist
                      </p>
                    </motion.div>
                  ))}
                </div>
              </Section>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
