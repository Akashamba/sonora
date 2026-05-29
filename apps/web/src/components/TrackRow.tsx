import { motion } from 'framer-motion'
import { Play, Pause } from 'lucide-react'
import { cn, formatTime } from '@/lib/utils'
import type { Track } from '@/data/mockData'

interface TrackRowProps {
  track: Track
  index?: number
  onPlay?: () => void
  isPlaying?: boolean
  isCurrentTrack?: boolean
  showIndex?: boolean
}

export function TrackRow({ 
  track, 
  index, 
  onPlay, 
  isPlaying, 
  isCurrentTrack, 
  showIndex = true 
}: TrackRowProps) {
  return (
    <motion.div
      className={cn(
        'group flex items-center gap-4 rounded-xl px-3 py-2 transition-colors cursor-pointer',
        isCurrentTrack 
          ? 'bg-[var(--background-floating)]' 
          : 'hover:bg-[var(--background-elevated)]'
      )}
      whileTap={{ scale: 0.99 }}
      onClick={onPlay}
    >
      {/* Index / Play button */}
      <div className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center">
        {showIndex && (
          <span className={cn(
            'text-sm tabular-nums transition-opacity group-hover:opacity-0',
            isCurrentTrack ? 'text-[var(--accent)]' : 'text-[var(--foreground-muted)]'
          )}>
            {index !== undefined ? index + 1 : ''}
          </span>
        )}
        <motion.button
          className={cn(
            'absolute inset-0 flex items-center justify-center rounded-lg transition-opacity',
            showIndex ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
          )}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
        >
          {isPlaying && isCurrentTrack ? (
            <Pause 
              className="h-4 w-4 fill-current" 
              style={{ color: track.accentColor }} 
            />
          ) : (
            <Play 
              className="h-4 w-4 fill-current ml-0.5" 
              style={{ color: isCurrentTrack ? track.accentColor : 'var(--foreground)' }} 
            />
          )}
        </motion.button>
      </div>

      {/* Album art */}
      <div 
        className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg"
        style={{
          boxShadow: isCurrentTrack ? `0 4px 16px ${track.accentColor}30` : undefined,
        }}
      >
        <img
          src={track.coverUrl}
          alt={track.album}
          className="h-full w-full object-cover"
        />
        {isCurrentTrack && isPlaying && (
          <div 
            className="absolute inset-0 flex items-center justify-center bg-black/30"
            style={{ boxShadow: `inset 0 0 20px ${track.accentColor}40` }}
          >
            <div className="flex items-end gap-0.5 h-4">
              {[1, 2, 3].map((i) => (
                <motion.div
                  key={i}
                  className="w-1 rounded-full"
                  style={{ backgroundColor: track.accentColor }}
                  animate={{
                    height: ['40%', '100%', '60%', '80%', '40%'],
                  }}
                  transition={{
                    duration: 0.8,
                    repeat: Infinity,
                    delay: i * 0.15,
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Track info */}
      <div className="flex-1 min-w-0">
        <h4 className={cn(
          'truncate text-sm font-medium',
          isCurrentTrack ? 'text-[var(--accent)]' : 'text-[var(--foreground)]'
        )}>
          {track.title}
        </h4>
        <p className="truncate text-xs text-[var(--foreground-secondary)]">
          {track.artist}
        </p>
      </div>

      {/* Duration */}
      <span className="flex-shrink-0 text-xs tabular-nums text-[var(--foreground-muted)]">
        {formatTime(track.duration)}
      </span>
    </motion.div>
  )
}
