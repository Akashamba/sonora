import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

const GAP = 6;
const EDGE = 8;

// Lowest y a menu may reach: the top of the mobile mini player or tab bar when they are
// showing, otherwise the viewport bottom. Both are display:none on desktop, so they measure 0.
function bottomLimit() {
  let limit = window.innerHeight;
  document
    .querySelectorAll<HTMLElement>(".mobile-mini-player, .mobile-tabs")
    .forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.height > 0) limit = Math.min(limit, r.top);
    });
  return limit;
}

// Places a menu against its anchor button. It opens below the anchor, flips above when
// there is no room below, right-aligns to the anchor, and clamps to the visible area.
function place(menu: HTMLElement, anchor: HTMLElement) {
  const limit = bottomLimit();
  menu.style.maxHeight = `${Math.max(120, limit - 2 * EDGE)}px`;
  const a = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = Math.min(menu.offsetHeight, limit - 2 * EDGE);

  // Below the anchor unless that runs past the limit and the space above is roomier.
  const spaceBelow = limit - EDGE - (a.bottom + GAP);
  const spaceAbove = a.top - GAP - EDGE;
  const wanted =
    height <= spaceBelow || spaceBelow >= spaceAbove
      ? a.bottom + GAP
      : a.top - GAP - height;
  const top = Math.min(Math.max(EDGE, wanted), limit - EDGE - height);

  const left = Math.min(
    Math.max(EDGE, a.right - width),
    window.innerWidth - width - EDGE,
  );
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.right = "auto";
}

// Popover rendered into document.body, so no ancestor stacking context (the detail pages
// wrap their sections in z-index layers) can paint over it, and the mobile tab bar and mini
// player stay above it. Outside taps and Escape close it. Taps on the anchor are left to
// the anchor's own handler, which toggles it.
export function FloatingMenu({
  anchorRef,
  onClose,
  className = "",
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = anchorRef.current;
    if (menu && anchor) place(menu, anchor);
  });

  useEffect(() => {
    const reposition = () => {
      if (menuRef.current && anchorRef.current)
        place(menuRef.current, anchorRef.current);
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [anchorRef, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className={`track-popover floating-menu ${className}`}
      style={{ position: "fixed", top: 0, left: 0, overflowY: "auto" }}
    >
      {children}
    </div>,
    document.body,
  );
}
