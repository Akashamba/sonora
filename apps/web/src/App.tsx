import { Routes, Route } from 'react-router-dom'
import { PlayerProvider } from '@/context/PlayerContext'
import { BottomNav } from '@/components/BottomNav'
import { Sidebar } from '@/components/Sidebar'
import { MiniPlayer } from '@/components/MiniPlayer'
import { NowPlayingScreen } from '@/components/NowPlayingScreen'
import { HomePage } from '@/pages/HomePage'
import { SearchPage } from '@/pages/SearchPage'
import { LibraryPage } from '@/pages/LibraryPage'
import { ImportPage } from '@/pages/ImportPage'

export default function App() {
  return (
    <PlayerProvider>
      <div className="relative min-h-screen bg-[var(--background)]">
        {/* Desktop Sidebar */}
        <Sidebar />
        
        {/* Main content area */}
        <main className="md:ml-64">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/import" element={<ImportPage />} />
          </Routes>
        </main>

        {/* Mini Player */}
        <MiniPlayer />
        
        {/* Now Playing Screen */}
        <NowPlayingScreen />
        
        {/* Mobile Bottom Navigation */}
        <BottomNav />
      </div>
    </PlayerProvider>
  )
}
