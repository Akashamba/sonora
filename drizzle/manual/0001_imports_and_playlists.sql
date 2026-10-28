PRAGMA foreign_keys = ON;

CREATE TABLE playlists (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  source_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE playlist_tracks (
  id TEXT PRIMARY KEY NOT NULL,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks_table(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (playlist_id, position)
);

CREATE INDEX playlist_tracks_playlist_idx ON playlist_tracks(playlist_id);

CREATE TABLE imports (
  id TEXT PRIMARY KEY NOT NULL,
  source_url TEXT NOT NULL,
  mode TEXT NOT NULL,
  title TEXT,
  musicbrainz_release_id TEXT,
  musicbrainz_release_group_id TEXT,
  playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE jobs ADD COLUMN import_id TEXT REFERENCES imports(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN position INTEGER;
ALTER TABLE jobs ADD COLUMN track_id TEXT REFERENCES tracks_table(id) ON DELETE SET NULL;

CREATE INDEX jobs_import_position_idx ON jobs(import_id, position);
