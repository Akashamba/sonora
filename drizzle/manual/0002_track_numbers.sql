-- Track and disc numbers, so album pages list songs in album order.
-- Both columns are nullable: rows stay null until scripts/backfill-track-numbers.ts
-- (or a new ingest) fills them. Run once per database; ADD COLUMN fails if rerun.
ALTER TABLE tracks_table ADD COLUMN disc_number INTEGER;
ALTER TABLE tracks_table ADD COLUMN track_number INTEGER;
