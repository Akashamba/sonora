import { motion } from 'framer-motion'
import { Section } from '@/components/Section'
import { MediaCard } from '@/components/MediaCard'
import { TrackRow } from '@/components/TrackRow'
import { usePlayer } from '@/context/PlayerContext'
import { 
  recentTracks, 
  favoriteTracks, 
  recommendedTracks,
  recentAlbums,
  favoriteAlbums,
} from '@/data/mockData'

export function HomePage() {
  const { playTrack, currentTrack, isPlaying } = usePlayer()

  return (
    <motion.div
      className="min-h-screen pb-40"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      {/* Header */}
      <header className="sticky top-0 z-10 bg-[var(--background)]/80 px-4 py-6 backdrop-blur-xl md:px-8">
        <h1 className="text-3xl font-bold text-[var(--foreground)]">Good evening</h1>
        <p className="mt-1 text-[var(--foreground-secondary)]">
          Pick up where you left off
        </p>
      </header>

      {/* Recent Activity - Albums */}
      <Section title="Recently Played" subtitle="Jump back in">
        <div className="flex gap-4 overflow-x-auto px-4 pb-4 scrollbar-hide">
          {recentAlbums.map((album) => (
            <MediaCard
              key={album.id}
              item={album}
              type="album"
              size="md"
            />
          ))}
          {recentTracks.slice(0, 3).map((track) => (
            <MediaCard
              key={track.id}
              item={track}
              type="track"
              size="md"
              onPlay={() => playTrack(track)}
              isPlaying={currentTrack?.id === track.id && isPlaying}
            />
          ))}
        </div>
      </Section>

      {/* Recent Activity - Track List */}
      <Section title="Recent Songs">
        <div className="px-4">
          <div className="rounded-2xl bg-[var(--background-elevated)] p-2">
            {recentTracks.map((track, index) => (
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

      {/* Favorites */}
      <Section title="Your Favorites" subtitle="Most played">
        <div className="flex gap-4 overflow-x-auto px-4 pb-4 scrollbar-hide">
          {favoriteAlbums.map((album) => (
            <MediaCard
              key={album.id}
              item={album}
              type="album"
              size="lg"
            />
          ))}
        </div>
      </Section>

      {/* Favorite Tracks */}
      <Section title="Top Tracks">
        <div className="px-4">
          <div className="rounded-2xl bg-[var(--background-elevated)] p-2">
            {favoriteTracks.slice(0, 5).map((track, index) => (
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

      {/* Recommendations */}
      <Section title="Recommended for You" subtitle="Based on your listening">
        <div className="flex gap-4 overflow-x-auto px-4 pb-4 scrollbar-hide">
          {recommendedTracks.map((track) => (
            <MediaCard
              key={track.id}
              item={track}
              type="track"
              size="md"
              onPlay={() => playTrack(track)}
              isPlaying={currentTrack?.id === track.id && isPlaying}
            />
          ))}
        </div>
      </Section>

      {/* More Recommendations */}
      <Section title="Discover Weekly">
        <div className="px-4">
          <div className="rounded-2xl bg-[var(--background-elevated)] p-2">
            {recommendedTracks.slice(0, 6).map((track, index) => (
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
    </motion.div>
  )
}
