import { useCallback, useRef, useState } from "react";

export type Tab = "songs" | "albums" | "artists" | "import";

export type PageId =
  | "songs-page"
  | "albums-page"
  | "artists-page"
  | "import-page"
  | "album-detail-page"
  | "artist-detail-page"
  | "queue-page"
  | "player-page"
  | "playlists-page"
  | "library-page";

export function useNav() {
  const [page, setPage] = useState<PageId>("songs-page");
  const [tab, setTab] = useState<Tab>("songs");
  // Where the back button goes. null means fall back to the current tab.
  const previousPage = useRef<PageId | null>(null);

  // Show a page. Passing `from` sets where back returns to.
  const go = useCallback((next: PageId, from?: PageId) => {
    if (from !== undefined) previousPage.current = from;
    setPage(next);
  }, []);

  const showTab = useCallback((next: Tab) => {
    setTab(next);
    previousPage.current = null;
    setPage(`${next}-page`);
  }, []);

  const goBack = useCallback(() => {
    if (previousPage.current) {
      setPage(previousPage.current);
      previousPage.current = null;
    } else {
      showTab(tab);
    }
  }, [tab, showTab]);

  return { page, tab, go, showTab, goBack };
}

export type Nav = ReturnType<typeof useNav>;
