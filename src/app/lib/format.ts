import type { ArtistCredit } from "./types";

// Milliseconds to m:ss. Missing length shows as "?:??".
export function fmt(ms: number | null | undefined): string {
  if (!ms) return "?:??";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Seconds (may be fractional) to m:ss.
export function fmtSec(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

// Milliseconds to a year. Missing date shows as an em dash.
export function fmtDate(ms: number | null | undefined): string | number {
  if (!ms) return "—";
  return new Date(ms).getFullYear();
}

export function artistCredit(
  artists: ArtistCredit[] | null | undefined,
): string {
  if (!artists || !artists.length) return "";
  // Some tracks come back with the same artist repeated; one credit per artist id.
  const seen = new Set<string>();
  return [...artists]
    .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))
    .filter((a) => {
      const key = a.id ?? a.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((a) => a.name + (a.joinphrase ?? ""))
    .join("");
}
