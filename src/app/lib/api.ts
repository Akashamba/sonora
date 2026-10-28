export const ENDPOINTS = {
  config: () => `/config`,
  home: () => `/home`,
  albums: () => `/release-groups`,
  artists: () => `/artists`,
  albumTracks: (id: string) => `/release-groups/${id}/tracks`,
  artistTracks: (id: string) => `/artists/${id}/tracks`,
  nextTrackId: () => `/tracks/next`,
  prevTrackId: () => `/tracks/previous`,
  getTrackMetadata: (id: string) => `/tracks/${id}/metadata`,
  streamTrack: (id: string) => `/tracks/${id}/stream`,
  importUrl: () => `/import`,
  queue: () => `/queue`,
  searchTracks: (q: string, limit = 50) =>
    `/tracks/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=0`,
  toggleLikeTrack: (id: string) => `/tracks/${id}/like`,
  queueAlbum: (id: string, shuffle = false) =>
    `/release-groups/${id}/queue${shuffle ? "?shuffle=1" : ""}`,
  queueTracks: () => `/queue/tracks`,
  queuePlayFrom: () => `/queue/play-from`,
  playlists: () => `/playlists`,
  playlist: (id: string) => `/playlists/${id}`,
  playlistTracks: (id: string) => `/playlists/${id}/tracks`,
  playlistTrack: (id: string, entryId: string) =>
    `/playlists/${id}/tracks/${entryId}`,
  playlistQueue: (id: string, shuffle = false) =>
    `/playlists/${id}/queue${shuffle ? "?shuffle=1" : ""}`,
  importPreview: () => `/import/preview`,
  imports: () => `/imports`,
  importStatus: (id: string) => `/imports/${id}`,
};

// GET + JSON. Errors read "<status> <statusText>".
export async function apiFetch<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

// Writes. Errors are the bare status code, which the demo-mode checks compare against "403".
export async function apiRequest(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status}`);
  // A 204 has no body, and Chromium reports a response whose body was never read as
  // net::ERR_ABORTED, even though the status came through. Reading the empty body closes it out.
  if (res.status === 204) await res.text();
  return res;
}

// Queue writes return the first track that will play. Demo mode gives 403, same as other writes.
export async function postQueue(
  url: string,
  body?: { trackIds: string[]; shuffle?: boolean },
): Promise<string | undefined> {
  const res = await apiRequest(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as { data?: { track_id?: string } };
  return json.data?.track_id;
}

// Text for a failed queue write. Demo mode gives 403.
export const queueFailure = (e: unknown) =>
  errorMessage(e) === "403"
    ? "Queueing is disabled in demo mode."
    : `Could not queue: ${errorMessage(e)}`;

export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
