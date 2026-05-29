import { motion, AnimatePresence } from 'framer-motion'
import { 
  Play, 
  Pause, 
  SkipBack, 
  SkipForward, 
  Shuffle, 
  Repeat, 
  Repeat1,
  Heart,
  Share2,
  ChevronDown,
  ListMusic,
  Mic2
} from 'lucide-react'
import * as Slider from '@radix-ui/react-slider'
import { usePlayer } from '@/context/PlayerContext'
import { formatTime } from '@/lib/utils'

export function NowPlayingScreen() {
  const {
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    shuffle,
    repeat,
    togglePlay,
    nextTrack,
    prevTrack,
    seekTo,
    toggleShuffle,
    toggleRepeat,
    closeNowPlaying,
    isNowPlayingOpen,
  } = usePlayer()

  if (!currentTrack) return null

  return (
    <AnimatePresence>
      {isNowPlayingOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex flex-col overflow-hidden"
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        >
          {/* Animated background */}
          <div className="absolute inset-0">
            <motion.div
              className="absolute inset-0"
              style={{ backgroundColor: 'var(--background)' }}
            />
            <motion.div
              className="absolute inset-0 opacity-40"
              style={{
                background: `radial-gradient(ellipse at 50% 0%, ${currentTrack.accentColor}40 0%, transparent 60%)`,
              }}
              animate={{
                opacity: [0.3, 0.5, 0.3],
              }}
              transition={{
                duration: 4,
                repeat: Infinity,
                ease: 'easeInOut',
              }}
            />
            <motion.div
              className="absolute inset-0"
              style={{
                background: `radial-gradient(ellipse at 50% 100%, ${currentTrack.accentColor}20 0%, transparent 50%)`,
              }}
            />
            {/* Blurred album art background */}
            <div 
              className="absolute inset-0 opacity-20 blur-3xl scale-150"
              style={{
                backgroundImage: `url(${currentTrack.coverUrl})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            />
          </div>

          {/* Content */}
          <div className="relative flex flex-1 flex-col px-6 pt-safe">
            {/* Header */}
            <div className="flex items-center justify-between py-4">
              <motion.button
                className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--background-floating)]/60 backdrop-blur-sm"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={closeNowPlaying}
              >
                <ChevronDown className="h-5 w-5 text-[var(--foreground)]" />
              </motion.button>
              
              <div className="text-center">
                <p className="text-xs font-medium uppercase tracking-wider text-[var(--foreground-muted)]">
                  Playing from
                </p>
                <p className="text-sm font-medium text-[var(--foreground-secondary)]">
                  {currentTrack.album}
                </p>
              </div>

              <motion.button
                className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--background-floating)]/60 backdrop-blur-sm"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                <ListMusic className="h-5 w-5 text-[var(--foreground)]" />
              </motion.button>
            </div>

            {/* Album art */}
            <div className="flex flex-1 items-center justify-center py-8">
              <motion.div
                className="relative aspect-square w-full max-w-[320px]"
                layoutId="player-artwork"
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.1 }}
              >
                <div
                  className="h-full w-full overflow-hidden rounded-3xl"
                  style={{
                    boxShadow: `0 24px 80px ${currentTrack.accentColor}40, 0 8px 32px rgba(0,0,0,0.4)`,
                  }}
                >
                  <img
                    src={currentTrack.coverUrl}
                    alt={currentTrack.album}
                    className="h-full w-full object-cover"
                  />
                </div>
                {/* Glow effect */}
                <div
                  className="absolute -inset-4 -z-10 rounded-3xl opacity-50 blur-3xl"
                  style={{ backgroundColor: currentTrack.accentColor }}
                />
              </motion.div>
            </div>

            {/* Track info */}
            <div className="mb-6 flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <motion.h1
                  className="text-2xl font-bold text-[var(--foreground)] truncate"
                  layoutId="player-title"
                >
                  {currentTrack.title}
                </motion.h1>
                <motion.p
                  className="text-lg text-[var(--foreground-secondary)]"
                  layoutId="player-artist"
                >
                  {currentTrack.artist}
                </motion.p>
              </div>
              <motion.button
                className="ml-4 flex h-10 w-10 items-center justify-center rounded-full"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
              >
                <Heart className="h-6 w-6 text-[var(--foreground-secondary)]" />
              </motion.button>
            </div>

            {/* Progress bar */}
            <div className="mb-6">
              <Slider.Root
                className="relative flex h-5 w-full touch-none select-none items-center"
                value={[currentTime]}
                max={duration}
                step={1}
                onValueChange={([value]) => seekTo(value)}
              >
                <Slider.Track className="relative h-1 flex-grow rounded-full bg-[var(--border-interactive)]">
                  <Slider.Range 
                    className="absolute h-full rounded-full"
                    style={{ backgroundColor: currentTrack.accentColor }}
                  />
                </Slider.Track>
                <Slider.Thumb 
                  className="block h-4 w-4 rounded-full bg-[var(--foreground)] shadow-lg focus:outline-none"
                  style={{
                    boxShadow: `0 2px 8px rgba(0,0,0,0.3), 0 0 12px ${currentTrack.accentColor}60`,
                  }}
                />
              </Slider.Root>
              <div className="mt-2 flex justify-between text-xs tabular-nums text-[var(--foreground-muted)]">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            {/* Playback controls */}
            <div className="mb-8 flex items-center justify-between">
              <motion.button
                className="flex h-10 w-10 items-center justify-center rounded-full"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={toggleShuffle}
              >
                <Shuffle 
                  className="h-5 w-5" 
                  style={{ 
                    color: shuffle ? currentTrack.accentColor : 'var(--foreground-muted)' 
                  }}
                />
              </motion.button>

              <motion.button
                className="flex h-12 w-12 items-center justify-center rounded-full"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={prevTrack}
              >
                <SkipBack className="h-7 w-7 fill-current text-[var(--foreground)]" />
              </motion.button>

              <motion.button
                className="flex h-16 w-16 items-center justify-center rounded-full"
                style={{
                  backgroundColor: currentTrack.accentColor,
                  boxShadow: `0 8px 32px ${currentTrack.accentColor}50`,
                }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={togglePlay}
              >
                {isPlaying ? (
                  <Pause className="h-7 w-7 fill-current text-white" />
                ) : (
                  <Play className="h-7 w-7 fill-current text-white ml-1" />
                )}
              </motion.button>

              <motion.button
                className="flex h-12 w-12 items-center justify-center rounded-full"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={nextTrack}
              >
                <SkipForward className="h-7 w-7 fill-current text-[var(--foreground)]" />
              </motion.button>

              <motion.button
                className="flex h-10 w-10 items-center justify-center rounded-full"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={toggleRepeat}
              >
                {repeat === 'one' ? (
                  <Repeat1 
                    className="h-5 w-5" 
                    style={{ color: currentTrack.accentColor }}
                  />
                ) : (
                  <Repeat 
                    className="h-5 w-5" 
                    style={{ 
                      color: repeat === 'all' ? currentTrack.accentColor : 'var(--foreground-muted)' 
                    }}
                  />
                )}
              </motion.button>
            </div>

            {/* Additional actions */}
            <div className="mb-8 flex items-center justify-center gap-8 pb-safe">
              <motion.button
                className="flex flex-col items-center gap-1"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                <Mic2 className="h-5 w-5 text-[var(--foreground-secondary)]" />
                <span className="text-xs text-[var(--foreground-muted)]">Lyrics</span>
              </motion.button>

              <motion.button
                className="flex flex-col items-center gap-1"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                <Share2 className="h-5 w-5 text-[var(--foreground-secondary)]" />
                <span className="text-xs text-[var(--foreground-muted)]">Share</span>
              </motion.button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
