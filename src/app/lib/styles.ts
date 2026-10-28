// Tailwind class strings shared across pages. They mirror the classes of the vanilla CSS they replace.

export const pageSubtitle =
  "text-muted text-[11px] uppercase tracking-[0.1em] mb-7";
export const searchInput =
  "w-full max-w-[420px] mb-4 bg-surface border border-edge text-ink font-mono text-[16px] leading-[normal] px-2.5 py-2 outline-none";
export const list = "flex flex-col gap-px";
export const listItem =
  "flex items-center gap-4 px-4 py-3.5 bg-surface cursor-pointer transition-[background] duration-100";
export const itemThumb =
  "w-11 h-11 rounded bg-edge shrink-0 overflow-hidden flex items-center justify-center text-lg text-muted";
export const itemInfo = "flex-1 min-w-0";
export const itemTitle =
  "text-[13px] text-ink whitespace-nowrap overflow-hidden text-ellipsis";
export const itemMeta =
  "text-[11px] text-muted mt-[3px] whitespace-nowrap overflow-hidden text-ellipsis";
export const itemRight = "flex items-center gap-3 shrink-0";
export const itemDuration = "text-[11px] text-muted min-w-9 text-right";
export const playBtn =
  "w-[30px] h-[30px] rounded-full bg-accent border-none cursor-pointer flex items-center justify-center shrink-0 transition-[transform,background] duration-150 hover:scale-110";
export const arrowBtn =
  "w-[30px] h-[30px] bg-transparent border border-edge text-muted cursor-pointer flex items-center justify-center transition-colors duration-150 hover:text-ink hover:border-muted";
export const typeBadge =
  "text-[10px] uppercase tracking-[0.1em] text-muted border border-edge px-1.5 py-0.5 shrink-0";
export const backBtn =
  "bg-transparent border border-edge text-muted font-mono text-[11px] uppercase tracking-[0.08em] px-3 py-1.5 cursor-pointer mb-6 inline-flex items-center gap-1.5 transition-colors duration-150 hover:text-ink hover:border-muted";
// Small "queue" button on the album header. Its own string, since mixing text sizes with backBtn doesn't resolve.
export const queueBtn =
  "bg-transparent border border-edge text-muted font-mono text-[10px] uppercase tracking-[0.08em] px-2.5 py-1 cursor-pointer mb-6 inline-flex items-center gap-1.5 transition-colors duration-150 hover:text-ink hover:border-muted";
export const stateMsg =
  "py-12 text-center text-muted text-xs tracking-[0.08em]";
export const stateError = "text-accent2";
export const ctrlBtn =
  "w-10 h-10 bg-transparent border border-edge text-muted cursor-pointer flex items-center justify-center transition-colors duration-150 hover:text-ink hover:border-muted";
export const sectionHeader =
  "text-[10px] tracking-[0.12em] uppercase text-muted mb-2";
