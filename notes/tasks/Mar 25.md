Mar 25. Last updated april 8, 2026

# Sonora Tasks

- [ ] add position within an album (set position to nullable, seed db, set to not null, make sure there is no data loss)

- [ ] insert album at the top of the queue
  - [ ] insert when playing instead of a separate button
  - [ ] insert slice of album starting at the track that is selected
- [ ] sign in

- [ ] user ids to relevant tables

- [ ] schema updates
  - [ ] add primary key to track_artists table ((t) => [primaryKey({ columns: [t.track_id, t.artist_id, t.pos] })])
  - [ ] add indices and constraints to tables

## Prod Tasks

- [x] move ingest to a separate process
- [ ] prepare my Bun server for production
- [ ] set up hook to auto deploy + ci/cd, maybe using github actions or something similar, to make it easier to update the server when I make changes.
