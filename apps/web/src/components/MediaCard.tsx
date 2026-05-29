import { motion } from 'framer-motion'
import { Play, Pause } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Track, Album } from '@/data/mockData'

interface MediaCardProps {
  item: Track | Album
  type: 'track' | 'album'
  onPlay?: () => void
  isPlaying?: boolean
  size?: 'sm' | 'md' | 'lg'
}

export function MediaCard({ item, type, onPlay, isPlaying, size = 'md' }: MediaCardProps) {
  const sizeClasses = {
    sm: 'w-32',
    md: 'w-40',
    lg: 'w-48',
  }

  const imageSizeClasses = {
    sm: 'h-32',
    md: 'h-40',
    lg: 'h-48',
  }

  return (
    <motion.div
      className={cn('group flex-shrink-0 cursor-pointer', sizeClasses[size])}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={onPlay}
    >
      <div className="relative">
        <div
          className={cn(
            'relative overflow-hidden rounded-2xl',
            imageSizeClasses[size]
          )}
          style={{
            boxShadow: `0 8px 32px ${item.accentColor}20`,
          }}
        >
          <img
            src={item.coverUrl}
            alt={item.title}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
          
          {/* Hover overlay with play button */}
          <motion.div
            className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100"
            initial={false}
          >
            <motion.button
              className="flex h-12 w-12 items-center justify-center rounded-full bg-white/90 text-[var(--background)] shadow-lg backdrop-blur-sm"
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              style={{
                boxShadow: `0 4px 20px ${item.accentColor}40`,
              }}
            >
              {isPlaying ? (
                <Pause className="h-5 w-5 fill-current" />
              ) : (
                <Play className="h-5 w-5 fill-current ml-0.5" />
              )}
            </motion.button>
          </motion.div>
        </div>
        
        {/* Accent glow effect */}
        <div
          className="absolute -inset-1 -z-10 rounded-2xl opacity-0 blur-xl transition-opacity duration-300 group-hover:opacity-60"
          style={{ backgroundColor: item.accentColor }}
        />
      </div>
      
      <div className="mt-3 px-1">
        <h3 className="truncate text-sm font-medium text-[var(--foreground)]">
          {item.title}
        </h3>
        <p className="truncate text-xs text-[var(--foreground-secondary)]">
          {item.artist}
        </p>
      </div>
    </motion.div>
  )
}
