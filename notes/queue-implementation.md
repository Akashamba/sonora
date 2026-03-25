- queue is a db table that stores song ids
- position
  - determined using floating points. (considered string keys, but choosing floating point keys to keep db light)
  - insert at the beignning or end (not using a gap since it makes no difference)
  - insert in between with prev+next/2
  - rebalance when difference between a particular gap is less than 1e-9 (or a better threshold)

- when there is a req to /random
  - delete songid with smallest position from queue and return songid
  - if there are less than 20 songs in queue: fill with 40 random songs
  - /queue to get top 20 songs from queue

# current status

- queue exists
- can be seen
- auto refills
- use uuidv7 for id based sorting + unlimited string-based positon counter

# TODOs (basic)

- [ ] play from middle of queue should pop everything before
- [x] add a whole album to queue
- [ ] insert, reorder, delete
- [ ] add slice of album to queue

# TODOs (architectural)

- keep only one endpoint to stream from and a few endpoints to update queue with either random tracks, tracks from an album, by an artist, or manually add to and remove from queue
- add userid

# Note on uuidv7

UUIDv7 IDs are time-ordered (timestamp-based) and generally increase as tracks are added to the queue. We rely on this property to sort items by insertion order using ORDER BY id, rather than maintaining a separate position column. While not strictly sequential across all environments, they are sufficient for ordering within this system.

UUID v7 is not enough for queue, since I also need to insert at the beginning sometimes. hence I need a separate postion column with that uses floating point keys and fractional indexing.

for now, inserts can only be at the beginning or end of the queue.

When I add the ability to insert in between, I will need to add a function to rebalance the indices when the gap between two items is less than 1e-9.

# Note on floating point keys and rebalancing (16:59 at udem on 2026-03-25)

- realistically, new tracks are only going to get added:
  - at the beginning of the queue (when selecting a whole album, playing songs by an artist, etc)
  - at the end (when automatically refilling the queue)
  - right after the first track (with a per-track add to queue option that will default to playing the selected immediately after the current song)
  - out of all these interactions, only the last one needs rebalancing when indices lose precision.

- In addition, queue tracks can be reordered, but even then, there isn't a need a need for rebalancing since the index values can just be swapped / moved around to make things work without affecting the order.

- however, this a use case of fractional indexing for pos:
  - consider tracks with pos: 1,2,3,4,5, if I want to move 2 between 4 and 5, then the new queue should become 1,3,4,4.5,5.
  - this is much faster than updating the position value for songs 2,3, and 4 (O(n))
  - then if indices lose precision, I can rebalance
