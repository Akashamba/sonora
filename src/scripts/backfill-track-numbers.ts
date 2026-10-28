// One-off: fill disc_number and track_number for tracks stored before those columns
// existed. For each track with a MusicBrainz recording id and release group, it looks
// up the group's releases (paced, one lookup per group) and takes the position of the
// recording on the best release. Dry run unless --apply is passed.
//
//   bun run src/scripts/backfill-track-numbers.ts [--limit 5]
//   bun run src/scripts/backfill-track-numbers.ts --apply
//
// Safe to re-run: only rows whose track_number is still null are selected.
// Choice of release: official releases first, then the earliest date. When a
// recording sits on several editions with different positions, the output marks
// the track "ambiguous" so it can be checked before a second run.
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "~/server/db";
import { release_groups, tracks } from "~/server/db/schema";
import { fetchMusicBrainzReleasesForReleaseGroup } from "~/utils/metadata-utils";
import { trackPositionOnRelease } from "~/utils/trackPosition";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const limitIndex = args.indexOf("--limit");
const limit =
  limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1] ?? "", 10) : undefined;
if (limit !== undefined && !(limit > 0)) {
  console.error("--limit needs a positive number");
  process.exit(1);
}

type Pending = {
  trackId: string;
  title: string;
  recordingId: string;
  releaseGroupId: string;
};

const pending: Pending[] = db
  .select({
    trackId: tracks.id,
    title: tracks.title,
    recordingId: tracks.musicbrainz_recording_id,
    releaseGroupId: release_groups.musicbrainz_release_group_id,
  })
  .from(tracks)
  .innerJoin(release_groups, eq(release_groups.id, tracks.release_group_id))
  .where(
    and(
      isNotNull(tracks.musicbrainz_recording_id),
      isNotNull(release_groups.musicbrainz_release_group_id),
      isNull(tracks.track_number),
    ),
  )
  .orderBy(tracks.id)
  .limit(limit ?? Number.MAX_SAFE_INTEGER)
  .all()
  .map((row) => ({
    trackId: row.trackId,
    title: row.title,
    recordingId: row.recordingId!,
    releaseGroupId: row.releaseGroupId!,
  }));

console.log(
  JSON.stringify({
    event: "backfill_start",
    mode: apply ? "apply" : "dry_run",
    dbFile: process.env.DB_FILE_NAME,
    tracks: pending.length,
    limit: limit ?? null,
  }),
);

const byGroup = new Map<string, Pending[]>();
for (const track of pending) {
  const group = byGroup.get(track.releaseGroupId) ?? [];
  group.push(track);
  byGroup.set(track.releaseGroupId, group);
}

const officialFirst = (release: any) => (release.status === "Official" ? 0 : 1);

const counts = { wouldWrite: 0, written: 0, notOnRelease: 0, ambiguous: 0 };

for (const [releaseGroupId, group] of byGroup) {
  const releases =
    await fetchMusicBrainzReleasesForReleaseGroup(releaseGroupId);

  for (const track of group) {
    const candidates = releases
      .map((release) => ({
        release,
        position: trackPositionOnRelease(release, track.recordingId),
      }))
      .filter((c) => c.position !== null)
      .sort(
        (a, b) =>
          officialFirst(a.release) - officialFirst(b.release) ||
          String(a.release.date ?? "9999").localeCompare(
            String(b.release.date ?? "9999"),
          ),
      );

    const best = candidates[0];
    if (!best || !best.position) {
      counts.notOnRelease++;
      console.log(
        JSON.stringify({
          event: "track_number_skipped",
          trackId: track.trackId,
          title: track.title,
          releaseGroupId,
          reason: "recording_not_on_any_release",
          releasesChecked: releases.length,
        }),
      );
      continue;
    }

    const positions = new Set(
      candidates.map(
        (c) => `${c.position!.disc_number}/${c.position!.track_number}`,
      ),
    );
    const ambiguous = positions.size > 1;
    if (ambiguous) counts.ambiguous++;

    const { disc_number, track_number } = best.position;
    if (apply) {
      db.update(tracks)
        .set({ disc_number, track_number })
        .where(eq(tracks.id, track.trackId))
        .run();
      counts.written++;
    } else {
      counts.wouldWrite++;
    }
    console.log(
      JSON.stringify({
        event: apply ? "track_number_written" : "track_number_would_write",
        trackId: track.trackId,
        title: track.title,
        releaseGroupId,
        releaseId: best.release.id,
        releaseStatus: best.release.status ?? null,
        disc_number,
        track_number,
        candidateReleases: candidates.length,
        ambiguous,
      }),
    );
  }
}

console.log(
  JSON.stringify({
    event: "backfill_done",
    mode: apply ? "apply" : "dry_run",
    ...counts,
  }),
);
