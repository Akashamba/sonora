import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useApp } from "../context";
import { fmtSec } from "../lib/format";

interface ProgressBarProps {
  // Changes when the track changes. The bar goes back to zero.
  resetKey: string | null;
  total: string;
  // Show the time left ("-2:52") on the right instead of the total length.
  remaining?: boolean;
}

// Seek bar with pointer scrubbing. Dragging previews the position, and the seek commits on release.
export function ProgressBar({
  resetKey,
  total,
  remaining = false,
}: ProgressBarProps) {
  const { player } = useApp();
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const pending = useRef(0);

  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  // Fraction shown while dragging. null when not dragging.
  const [preview, setPreview] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  useEffect(() => {
    setPosition(0);
  }, [resetKey]);

  useEffect(() => {
    const el = player.audioRef.current;
    if (!el) return;
    const onTime = () => {
      // Playback updates pause while the user is dragging.
      if (dragging.current) return;
      const dur = el.duration;
      if (!dur || !Number.isFinite(dur)) return;
      setPosition(el.currentTime);
      setDuration(dur);
    };
    const onEnded = () => {
      if (el.duration) setPosition(el.duration);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("ended", onEnded);
    };
  }, [player.audioRef]);

  const fraction = (e: PointerEvent<HTMLDivElement>) => {
    const rect = barRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = true;
    setScrubbing(true);
    barRef.current!.setPointerCapture(e.pointerId);
    const f = fraction(e);
    pending.current = f;
    setPreview(f);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    e.preventDefault();
    const f = fraction(e);
    pending.current = f;
    setPreview(f);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    e.preventDefault();
    dragging.current = false;
    setScrubbing(false);
    barRef.current!.releasePointerCapture(e.pointerId);
    // Only the release commits the seek.
    const el = player.audioRef.current!;
    if (el.duration) {
      el.currentTime = pending.current * el.duration;
      setPosition(el.currentTime);
    }
    setPreview(null);
  };

  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    setScrubbing(false);
    try {
      barRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      // capture was already released
    }
    setPreview(null);
  };

  const frac = preview ?? (duration ? position / duration : 0);
  const shownSec = preview !== null ? preview * duration : position;

  return (
    <div className="w-full">
      <div
        ref={barRef}
        className={`progress-bar relative mb-2 h-1 w-full touch-none overflow-hidden rounded-[2px] bg-edge transition-[height] duration-[120ms] ease-in-out select-none ${scrubbing ? "scrubbing" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div
          className="h-full w-0 bg-accent"
          style={{ width: `${frac * 100}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] tracking-[0.06em] text-muted">
        <span>{fmtSec(shownSec)}</span>
        <span>
          {remaining ? `-${fmtSec(Math.max(0, duration - shownSec))}` : total}
        </span>
      </div>
    </div>
  );
}
