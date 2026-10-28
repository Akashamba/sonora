-- Table DDL copied from the worktree tracks.sqlite (no data). Tests that need the full schema load it.
CREATE TABLE `artists_table` (
	`id` text PRIMARY KEY,
	`musicbrainz_id` text UNIQUE,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE TABLE `history_table` (
	`id` text PRIMARY KEY,
	`track_id` text,
	`completed` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_history_table_track_id_tracks_table_id_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks_table`(`id`) ON DELETE CASCADE
);
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
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY,
	`url` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
, `claim_count` integer DEFAULT 0 NOT NULL, import_id TEXT REFERENCES imports(id) ON DELETE SET NULL, position INTEGER, track_id TEXT REFERENCES tracks_table(id) ON DELETE SET NULL);
CREATE TABLE `play_stats_table` (
	`id` text PRIMARY KEY,
	`track_id` text UNIQUE,
	`count` integer DEFAULT 1,
	`liked` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_play_stats_table_track_id_tracks_table_id_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks_table`(`id`) ON DELETE CASCADE
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
CREATE TABLE playlists (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  source_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE `queue_table` (
	`id` text PRIMARY KEY,
	`track_id` text,
	`position` real NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_queue_table_track_id_tracks_table_id_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks_table`(`id`) ON DELETE CASCADE
);
CREATE TABLE `release_groups_table` (
	`id` text PRIMARY KEY,
	`musicbrainz_release_group_id` text UNIQUE,
	`musicbrainz_primary_type` text NOT NULL,
	`title` text NOT NULL,
	`cover_art_url` text,
	`first_release_date` integer NOT NULL,
	`cover_art_url_thumbnail_large` text,
	`cover_art_url_thumbnail_small` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE TABLE `track_artists` (
	`track_id` text,
	`artist_id` text,
	`pos` integer NOT NULL,
	`joinphrase` text,
	CONSTRAINT `fk_track_artists_track_id_tracks_table_id_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks_table`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_track_artists_artist_id_artists_table_id_fk` FOREIGN KEY (`artist_id`) REFERENCES `artists_table`(`id`) ON DELETE CASCADE
);
CREATE TABLE `tracks_table` (
	`id` text PRIMARY KEY,
	`youtube_id` text NOT NULL UNIQUE,
	`musicbrainz_recording_id` text UNIQUE,
	`release_group_id` text,
	`title` text NOT NULL,
	`first_release_date` integer NOT NULL,
	`length` integer NOT NULL,
	`file_path` text NOT NULL,
	`disc_number` integer,
	`track_number` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_tracks_table_release_group_id_release_groups_table_id_fk` FOREIGN KEY (`release_group_id`) REFERENCES `release_groups_table`(`id`) ON DELETE CASCADE
);
CREATE INDEX jobs_import_position_idx ON jobs(import_id, position);
CREATE INDEX playlist_tracks_playlist_idx ON playlist_tracks(playlist_id);
