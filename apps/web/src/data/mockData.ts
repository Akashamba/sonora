// Mock data for the music streaming app
export interface Track {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  coverUrl: string
  accentColor: string
}

export interface Album {
  id: string
  title: string
  artist: string
  coverUrl: string
  year: number
  tracks: Track[]
  accentColor: string
}

export interface Playlist {
  id: string
  title: string
  coverUrl: string
  trackCount: number
}

export interface Artist {
  id: string
  name: string
  imageUrl: string
  monthlyListeners: number
}

// Sample album covers using gradients as placeholders
const albumCovers = [
  'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400&h=400&fit=crop',
  'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=400&h=400&fit=crop',
  'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400&h=400&fit=crop',
  'https://images.unsplash.com/photo-1514320291840-2e0a9bf2a9ae?w=400&h=400&fit=crop',
  'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=400&h=400&fit=crop',
  'https://images.unsplash.com/photo-1504898770365-14faca6a7320?w=400&h=400&fit=crop',
  'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=400&h=400&fit=crop',
  'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=400&h=400&fit=crop',
]

const accentColors = [
  '#8B5CF6', // Vibrant orchid (default)
  '#F59E0B', // Amber
  '#10B981', // Emerald
  '#EC4899', // Pink
  '#3B82F6', // Blue
  '#EF4444', // Red
  '#6366F1', // Indigo
  '#14B8A6', // Teal
]

export const recentTracks: Track[] = [
  { id: '1', title: 'Midnight City', artist: 'M83', album: 'Hurry Up, We\'re Dreaming', duration: 243, coverUrl: albumCovers[0], accentColor: accentColors[0] },
  { id: '2', title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', duration: 200, coverUrl: albumCovers[1], accentColor: accentColors[1] },
  { id: '3', title: 'Electric Feel', artist: 'MGMT', album: 'Oracular Spectacular', duration: 229, coverUrl: albumCovers[2], accentColor: accentColors[2] },
  { id: '4', title: 'Starboy', artist: 'The Weeknd', album: 'Starboy', duration: 230, coverUrl: albumCovers[3], accentColor: accentColors[3] },
  { id: '5', title: 'Take On Me', artist: 'a-ha', album: 'Hunting High and Low', duration: 225, coverUrl: albumCovers[4], accentColor: accentColors[4] },
]

export const favoriteTracks: Track[] = [
  { id: '6', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', duration: 354, coverUrl: albumCovers[5], accentColor: accentColors[5] },
  { id: '7', title: 'Hotel California', artist: 'Eagles', album: 'Hotel California', duration: 390, coverUrl: albumCovers[6], accentColor: accentColors[6] },
  { id: '8', title: 'Stairway to Heaven', artist: 'Led Zeppelin', album: 'Led Zeppelin IV', duration: 482, coverUrl: albumCovers[7], accentColor: accentColors[7] },
  { id: '9', title: 'Sweet Child O\' Mine', artist: 'Guns N\' Roses', album: 'Appetite for Destruction', duration: 302, coverUrl: albumCovers[0], accentColor: accentColors[0] },
  { id: '10', title: 'Comfortably Numb', artist: 'Pink Floyd', album: 'The Wall', duration: 382, coverUrl: albumCovers[1], accentColor: accentColors[1] },
]

export const recommendedTracks: Track[] = [
  { id: '11', title: 'Paranoid Android', artist: 'Radiohead', album: 'OK Computer', duration: 384, coverUrl: albumCovers[2], accentColor: accentColors[2] },
  { id: '12', title: 'Time', artist: 'Pink Floyd', album: 'The Dark Side of the Moon', duration: 413, coverUrl: albumCovers[3], accentColor: accentColors[3] },
  { id: '13', title: 'Wish You Were Here', artist: 'Pink Floyd', album: 'Wish You Were Here', duration: 307, coverUrl: albumCovers[4], accentColor: accentColors[4] },
  { id: '14', title: 'November Rain', artist: 'Guns N\' Roses', album: 'Use Your Illusion I', duration: 537, coverUrl: albumCovers[5], accentColor: accentColors[5] },
  { id: '15', title: 'Under Pressure', artist: 'Queen & David Bowie', album: 'Hot Space', duration: 248, coverUrl: albumCovers[6], accentColor: accentColors[6] },
  { id: '16', title: 'Money', artist: 'Pink Floyd', album: 'The Dark Side of the Moon', duration: 382, coverUrl: albumCovers[7], accentColor: accentColors[7] },
]

export const recentAlbums: Album[] = [
  { id: 'a1', title: 'After Hours', artist: 'The Weeknd', coverUrl: albumCovers[1], year: 2020, tracks: [], accentColor: accentColors[1] },
  { id: 'a2', title: 'Hurry Up, We\'re Dreaming', artist: 'M83', coverUrl: albumCovers[0], year: 2011, tracks: [], accentColor: accentColors[0] },
  { id: 'a3', title: 'OK Computer', artist: 'Radiohead', coverUrl: albumCovers[2], year: 1997, tracks: [], accentColor: accentColors[2] },
  { id: 'a4', title: 'The Dark Side of the Moon', artist: 'Pink Floyd', coverUrl: albumCovers[3], year: 1973, tracks: [], accentColor: accentColors[3] },
]

export const favoriteAlbums: Album[] = [
  { id: 'a5', title: 'A Night at the Opera', artist: 'Queen', coverUrl: albumCovers[5], year: 1975, tracks: [], accentColor: accentColors[5] },
  { id: 'a6', title: 'Hotel California', artist: 'Eagles', coverUrl: albumCovers[6], year: 1976, tracks: [], accentColor: accentColors[6] },
  { id: 'a7', title: 'Led Zeppelin IV', artist: 'Led Zeppelin', coverUrl: albumCovers[7], year: 1971, tracks: [], accentColor: accentColors[7] },
  { id: 'a8', title: 'Appetite for Destruction', artist: 'Guns N\' Roses', coverUrl: albumCovers[0], year: 1987, tracks: [], accentColor: accentColors[0] },
]

export const playlists: Playlist[] = [
  { id: 'p1', title: 'Chill Vibes', coverUrl: albumCovers[2], trackCount: 24 },
  { id: 'p2', title: 'Workout Mix', coverUrl: albumCovers[4], trackCount: 32 },
  { id: 'p3', title: 'Road Trip', coverUrl: albumCovers[6], trackCount: 45 },
  { id: 'p4', title: 'Late Night', coverUrl: albumCovers[0], trackCount: 18 },
]

export const artists: Artist[] = [
  { id: 'ar1', name: 'Pink Floyd', imageUrl: albumCovers[3], monthlyListeners: 25000000 },
  { id: 'ar2', name: 'The Weeknd', imageUrl: albumCovers[1], monthlyListeners: 85000000 },
  { id: 'ar3', name: 'Queen', imageUrl: albumCovers[5], monthlyListeners: 45000000 },
  { id: 'ar4', name: 'Radiohead', imageUrl: albumCovers[2], monthlyListeners: 20000000 },
]

export const allTracks: Track[] = [...recentTracks, ...favoriteTracks, ...recommendedTracks]

export const recentSearches = [
  'The Weeknd',
  'Bohemian Rhapsody',
  'Pink Floyd',
  'Hotel California',
]
