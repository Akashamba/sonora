export const artistCredit = (artists: any) => {
  if (!artists || !artists.length) return "";
  return [...artists]
    .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))
    .map((a) => a.name + (a.joinphrase ?? ""))
    .join("");
};
