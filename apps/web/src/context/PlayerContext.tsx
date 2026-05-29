import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { type Track, recentTracks } from '@/data/mockData'

interface PlayerState {
  currentTrack: Track | null
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  shuffle: boolean
  repeat: 'off' | 'all' | 'one'
  queue: Track[]
  isNowPlayingOpen: boolean
}

interface PlayerContextType extends PlayerState {
  playTrack: (track: Track) => void
  togglePlay: () => void
  nextTrack: () => void
  prevTrack: () => void
  seekTo: (time: number) => void
  setVolume: (volume: number) => void
  toggleShuffle: () => void
  toggleRepeat: () => void
  addToQueue: (track: Track) => void
  openNowPlaying: () => void
  closeNowPlaying: () => void
}

const PlayerContext = createContext<PlayerContextType | null>(null)

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PlayerState>({
    currentTrack: recentTracks[0],
    isPlaying: false,
    currentTime: 45,
    duration: recentTracks[0].duration,
    volume: 0.8,
    shuffle: false,
    repeat: 'off',
    queue: recentTracks.slice(1),
    isNowPlayingOpen: false,
  })

  const playTrack = useCallback((track: Track) => {
    setState(prev => ({
      ...prev,
      currentTrack: track,
      isPlaying: true,
      currentTime: 0,
      duration: track.duration,
    }))
  }, [])

  const togglePlay = useCallback(() => {
    setState(prev => ({ ...prev, isPlaying: !prev.isPlaying }))
  }, [])

  const nextTrack = useCallback(() => {
    setState(prev => {
      if (prev.queue.length === 0) return prev
      const [next, ...rest] = prev.queue
      return {
        ...prev,
        currentTrack: next,
        queue: prev.currentTrack ? [...rest, prev.currentTrack] : rest,
        currentTime: 0,
        duration: next.duration,
      }
    })
  }, [])

  const prevTrack = useCallback(() => {
    setState(prev => {
      if (!prev.currentTrack) return prev
      const lastInQueue = prev.queue[prev.queue.length - 1]
      if (!lastInQueue) return { ...prev, currentTime: 0 }
      return {
        ...prev,
        currentTrack: lastInQueue,
        queue: [prev.currentTrack, ...prev.queue.slice(0, -1)],
        currentTime: 0,
        duration: lastInQueue.duration,
      }
    })
  }, [])

  const seekTo = useCallback((time: number) => {
    setState(prev => ({ ...prev, currentTime: time }))
  }, [])

  const setVolume = useCallback((volume: number) => {
    setState(prev => ({ ...prev, volume }))
  }, [])

  const toggleShuffle = useCallback(() => {
    setState(prev => ({ ...prev, shuffle: !prev.shuffle }))
  }, [])

  const toggleRepeat = useCallback(() => {
    setState(prev => ({
      ...prev,
      repeat: prev.repeat === 'off' ? 'all' : prev.repeat === 'all' ? 'one' : 'off',
    }))
  }, [])

  const addToQueue = useCallback((track: Track) => {
    setState(prev => ({ ...prev, queue: [...prev.queue, track] }))
  }, [])

  const openNowPlaying = useCallback(() => {
    setState(prev => ({ ...prev, isNowPlayingOpen: true }))
  }, [])

  const closeNowPlaying = useCallback(() => {
    setState(prev => ({ ...prev, isNowPlayingOpen: false }))
  }, [])

  return (
    <PlayerContext.Provider
      value={{
        ...state,
        playTrack,
        togglePlay,
        nextTrack,
        prevTrack,
        seekTo,
        setVolume,
        toggleShuffle,
        toggleRepeat,
        addToQueue,
        openNowPlaying,
        closeNowPlaying,
      }}
    >
      {children}
    </PlayerContext.Provider>
  )
}

export function usePlayer() {
  const context = useContext(PlayerContext)
  if (!context) {
    throw new Error('usePlayer must be used within a PlayerProvider')
  }
  return context
}
