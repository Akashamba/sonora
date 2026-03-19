import { randomUUID } from "crypto";
import { int, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tracks = sqliteTable("tracks_table", {
  id: text()
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  youtube_id: text().notNull().unique(),
  musicbrainz_recording_id: text().unique(),
  release_group_id: text().references(() => release_groups.id, {
    onDelete: "cascade",
  }), // to handle track <-> release_group relation
  title: text().notNull(),
  first_release_date: int({ mode: "timestamp_ms" }).notNull(),
  length: int().notNull(),
  file_path: text().notNull(),
  created_at: int("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updated_at: int("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const release_groups = sqliteTable("release_groups_table", {
  id: text()
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  musicbrainz_release_group_id: text().unique(),
  musicbrainz_primary_type: text().notNull(), // Album, EP, LP, Single, Mixtape (todo: add a check condition)
  title: text().notNull(),
  cover_art_url: text(),
  first_release_date: int({ mode: "timestamp_ms" }).notNull(),
  cover_art_url_thumbnail_large: text(),
  cover_art_url_thumbnail_small: text(),
  created_at: int("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updated_at: int("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const artists = sqliteTable("artists_table", {
  id: text()
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  musicbrainz_id: text().unique(),
  name: text().notNull(),
  created_at: int("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updated_at: int("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const queue = sqliteTable("queue_table", {
  // eventually this should handle queues for multiple users (for demos and just to show I can)
  id: text()
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  track_id: text().references(() => tracks.id, { onDelete: "cascade" }),
  position: real().notNull(),
  created_at: int("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updated_at: int("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/* Join Tables */

// track <-> artists relation: maps tracks to the artists who contributed to the track.
// Includes position of artists is list of artists of the song ordered by contribution.
export const track_artists = sqliteTable("track_artists", {
  track_id: text().references(() => tracks.id, { onDelete: "cascade" }),
  artist_id: text().references(() => artists.id, { onDelete: "cascade" }),
  pos: int().notNull(), // position in musicbrainz artist_credit list
  joinphrase: text(),
});

// // release_group <-> artists relation: maps release_groups to the main artists who contributed to the release_group
// export const album_artists = sqliteTable("album_artists", {
//   pos: int().notNull(), // position in musicbrainz artist_credit list
// });
