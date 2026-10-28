// YouTube ids that an ingest in this process is working on right now. A second job for
// the same video waits here, so it does not download the same file at the same time, and
// then takes the normal duplicate path. One worker process, so an in-memory map is enough.
const claims = new Map<string, Promise<void>>();

export async function claimYoutubeId(youtubeId: string) {
  let waited = false;
  while (claims.has(youtubeId)) {
    waited = true;
    await claims.get(youtubeId);
  }
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  claims.set(youtubeId, done);
  return {
    waited,
    release: () => {
      if (claims.get(youtubeId) === done) claims.delete(youtubeId);
      finish();
    },
  };
}
