import { motion, AnimatePresence } from 'framer-motion'
import { Play, Pause, ChevronUp } from 'lucide-react'
import { usePlayer } from '@/context/PlayerContext'
import { cn, formatTime } from '@/lib/utils'

export function MiniPlayer() {
  const { 
    currentTrack, 
    isPlaying, 
    togglePlay, 
    openNowPlaying,
    currentTime,
    duration,
    isNowPlayingOpen 
  } = usePlayer()

  if (!currentTrack || isNowPlayingOpen) return null

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <AnimatePresence>
      <motion.div
        className="fixed bottom-20 left-3 right-3 z-40 md:bottom-4 md:left-auto md:right-4 md:w-96"
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 100, opacity: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      >
        <motion.div
          className="relative overflow-hidden rounded-[var(--radius-floating)] border border-[var(--border)] bg-[var(--background-floating)]/95 backdrop-blur-xl"
          style={{
            boxShadow: `0 8px 32px rgba(0,0,0,0.4), 0 0 80px ${currentTrack.accentColor}15`,
          }}
          layoutId="player-container"
        >
          {/* Progress bar at top */}
          <div className="absolute left-0 right-0 top-0 h-0.5 bg-[var(--border)]">
            <motion.div
              className="h-full"
              style={{ 
                width: `${progress}%`,
                backgroundColor: currentTrack.accentColor,
              }}
              transition={{ duration: 0.1 }}
            />
          </div>

          <div 
            className="flex items-center gap-3 p-3 cursor-pointer"
            onClick={openNowPlaying}
          >
            {/* Album art */}
            <motion.div 
              className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-xl"
              layoutId="player-artwork"
              style={{
                boxShadow: `0 4px 16px ${currentTrack.accentColor}30`,
              }}
            >
              <img
                src={currentTrack.coverUrl}
                alt={currentTrack.album}
                className="h-full w-full object-cover"
              />
              {/* Subtle glow */}
              <div 
                className="absolute inset-0 opacity-30"
                style={{ 
                  background: `radial-gradient(circle at center, ${currentTrack.accentColor}40 0%, transparent 70%)` 
                }}
              />
            </motion.div>

            {/* Track info */}
            <div className="flex-1 min-w-0">
              <motion.h4 
                className="truncate text-sm font-medium text-[var(--foreground)]"
                layoutId="player-title"
              >
                {currentTrack.title}
              </motion.h4>
              <motion.p 
                className="truncate text-xs text-[var(--foreground-secondary)]"
                layoutId="player-artist"
              >
                {currentTrack.artist}
              </motion.p>
            </div>

            {/* Time display */}
            <span className="hidden text-xs tabular-nums text-[var(--foreground-muted)] md:block">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>

            {/* Play/Pause button */}
            <motion.button
              className={cn(
                'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full',
                'transition-colors'
              )}
              style={{ 
                backgroundColor: `${currentTrack.accentColor}20`,
                color: currentTrack.accentColor,
              }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={(e) => {
                e.stopPropagation()
                togglePlay()
              }}
            >
              {isPlaying ? (
                <Pause className="h-4 w-4 fill-current" />
              ) : (
                <Play className="h-4 w-4 fill-current ml-0.5" />
              )}
            </motion.button>

            {/* Expand indicator */}
            <ChevronUp className="h-4 w-4 text-[var(--foreground-muted)] md:hidden" />
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
