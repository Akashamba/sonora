import { useState } from "react";

// Attribution entries. Add new ones here.
const ATTRIBUTIONS = [
  {
    title: "brain & guts",
    artist: "R1L",
    license: "CC BY-NC-SA 4.0",
    source: "https://erwanlerale.bandcamp.com/album/brain-guts",
  },
  {
    title: "NIN Ghosts I-IV MD",
    artist: "Nine Inch Nails (arr. Mark Deutrom)",
    license: "CC BY-SA 4.0",
    source: "https://markdeutrom.bandcamp.com/album/nin-ghosts-i-iv-md",
  },
];

// Shown on load when the server runs in demo mode.
export function AboutModal({ initiallyOpen }: { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  if (!open) return null;

  const close = () => setOpen(false);

  return (
    <div className="fixed inset-0 z-[1000] flex items-start justify-center overflow-y-auto bg-black/75 px-4 py-10 backdrop-blur-[4px]">
      <div className="relative w-full max-w-[560px] rounded-xl border border-edge bg-surface px-10 pt-9 pb-8 font-mono text-[13px] text-ink">
        <button
          onClick={close}
          className="absolute top-4 right-4 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-edge bg-transparent text-sm text-muted transition-[color,border-color] duration-150 hover:border-muted hover:text-ink"
        >
          ✕
        </button>

        <div className="mb-1 font-serif text-[36px] italic tracking-[-0.5px] text-accent">
          Sonora Demo
        </div>
        <div className="mb-5 text-[11px] tracking-[0.1em] text-muted uppercase">
          Akash's personal music streaming server
        </div>

        <div className="mb-6 flex gap-4">
          <a
            href="https://github.com/akashamba/sonora"
            target="_blank"
            className="border-b border-accent/30 pb-px text-[11px] tracking-[0.08em] text-accent uppercase no-underline"
          >
            ↗ GitHub
          </a>
          <a
            href="https://akashamba.me"
            target="_blank"
            className="border-b border-accent/30 pb-px text-[11px] tracking-[0.08em] text-accent uppercase no-underline"
          >
            ↗ Portfolio
          </a>
        </div>

        <div className="text-xs leading-[1.9] text-[#999]">
          This is a demo of my personal music streaming server. The full project
          is on{" "}
          <a
            href="https://github.com/akashamba/sonora"
            target="_blank"
            className="text-accent no-underline"
          >
            GitHub
          </a>{" "}
          and is fully self-hostable — instructions are in the readme.
          <br />
          <br />
          Stack: <span className="text-ink">Bun · SQLite · Drizzle</span>
          <br />
          <br />
          Due to privacy and copyright reasons, this demo is{" "}
          <span className="font-medium text-ink">read-only</span> — features
          like importing from YouTube URLs and modifying the queue have been
          disabled.
        </div>

        <hr className="my-5 border-0 border-t border-edge" />

        <div className="mb-2.5 text-[10px] tracking-[0.12em] text-muted uppercase">
          Music attribution
        </div>
        <div className="mb-3.5 text-[11px] leading-[1.7] text-[#666]">
          All music in this demo is copyright-free. Full attributions below.
        </div>

        <div className="rounded-md border border-[#1e1e1e] bg-[#111] px-3.5 py-3">
          {ATTRIBUTIONS.map((a, i) => (
            <div
              key={a.title}
              className={i < ATTRIBUTIONS.length - 1 ? "mb-5" : ""}
            >
              <div className="mb-1 text-[13px] text-ink">
                {a.title} — <span className="text-accent">{a.artist}</span>
              </div>
              <div className="text-[11px] leading-[1.8] text-muted">
                License: {a.license} ·{" "}
                <a
                  href={a.source}
                  target="_blank"
                  className="text-[#888] underline"
                >
                  Source ↗
                </a>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={close}
          className="mt-6 w-full cursor-pointer rounded-md border-none bg-accent px-2.5 py-2.5 font-mono text-xs tracking-[0.08em] text-[#0d0d0d] uppercase transition-[background] duration-150 hover:bg-[#d8ff70]"
        >
          Enter →
        </button>
      </div>
    </div>
  );
}
