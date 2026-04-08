import { ingestTrack } from "~/services/ingestTrack";
import { claimJobs } from "./claimJobs";
import { db } from "~/server/db";
import { eq } from "drizzle-orm";
import { jobs } from "~/server/db/schema";

while (true) {
  const claimedJobs: { id: string; url: string }[] = await claimJobs(2);

  if (claimedJobs.length === 0) {
    await Bun.sleep(1000);
    continue;
  }

  await Promise.all(
    claimedJobs.map(async (j) => {
      try {
        await ingestTrack(j.url);
        db.update(jobs)
          .set({ status: "completed", updated_at: new Date() })
          .where(eq(jobs.id, j.id))
          .run();
      } catch (err) {
        db.update(jobs)
          .set({
            status: "failed",
            error: (err as Error).message,
            updated_at: new Date(),
          })
          .where(eq(jobs.id, j.id))
          .run();
      }
    }),
  );
}
