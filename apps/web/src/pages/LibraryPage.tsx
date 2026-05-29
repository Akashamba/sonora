import { motion } from 'framer-motion'
import { Music2 } from 'lucide-react'

export function LibraryPage() {
  return (
    <motion.div
      className="min-h-screen pb-40"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      <header className="sticky top-0 z-10 bg-[var(--background)]/80 px-4 py-6 backdrop-blur-xl md:px-8">
        <h1 className="text-3xl font-bold text-[var(--foreground)]">Library</h1>
        <p className="mt-1 text-[var(--foreground-secondary)]">
          Your music collection
        </p>
      </header>

      <div className="flex flex-col items-center justify-center px-4 py-20 text-center">
        <div 
          className="flex h-20 w-20 items-center justify-center rounded-2xl"
          style={{
            background: 'linear-gradient(135deg, var(--accent) 0%, #A78BFA 100%)',
            boxShadow: '0 8px 32px var(--accent-glow)',
          }}
        >
          <Music2 className="h-10 w-10 text-white" />
        </div>
        <h2 className="mt-6 text-xl font-semibold text-[var(--foreground)]">
          Your Library
        </h2>
        <p className="mt-2 max-w-xs text-[var(--foreground-muted)]">
          This page will show your saved albums, playlists, and liked songs.
        </p>
      </div>
    </motion.div>
  )
}
