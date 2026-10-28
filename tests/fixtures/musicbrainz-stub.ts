// Preload for child processes that run the import code. Answers MusicBrainz from the JSON
// file named by MB_STUB_FILE, and returns the search results in reverse order on every
// second search, so a test sees MusicBrainz change its response order between calls.
import { readFileSync } from "node:fs";

const stub = JSON.parse(readFileSync(process.env.MB_STUB_FILE!, "utf8")) as {
  releases: unknown[];
  byId: Record<string, unknown>;
};
let searches = 0;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (url.hostname !== "musicbrainz.org")
    throw new Error(`unexpected fetch in a test: ${url.href}`);
  if (url.pathname === "/ws/2/release") {
    searches++;
    const releases =
      searches % 2 === 1 ? stub.releases : [...stub.releases].reverse();
    return json({ count: releases.length, releases });
  }
  const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  const release = stub.byId[id];
  return release ? json(release) : json({ error: "not found" }, 404);
}) as unknown as typeof fetch;
