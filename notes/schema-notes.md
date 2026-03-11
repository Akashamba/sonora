# Explaining the Enum in the "Albums" schma

    - Album – A full, official music release by an artist; usually 8–15+ tracks and considered a major project.
    - LP (Long Play) – Originally a vinyl format (~40–60 min); today basically synonymous with a full album.
    - EP (Extended Play) – Shorter than an album, usually 3–7 tracks or ~10–30 minutes; often a smaller or experimental release.
    - Mixtape – Traditionally loosely released projects (often free), sometimes with freestyles, remixes, or uncleared samples; common in hip-hop.
    - Single – A single main track release, often with 0–2 additional versions or B-sides.
    - Compilation – A collection of previously released songs (e.g., greatest hits or label samplers).

# Relations

    - For now, apart from auth related schema, I have decided to stick with three tables: artists, albums, tracks (the next step would be to add genres and play_history).
    - In addition, I would require track_artists and track_albums, which are join tables representing the many to many relationship between albums <-> artists and albums <-> tracks.
    - The tracks <-> albums relation is many-to-one and can be efficiewntly handled during query time, using a join, without needing a join table.
