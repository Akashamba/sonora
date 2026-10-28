import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { CoverImage } from "../components/CoverImage";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { TrackRow } from "../components/TrackRow";
import { useApp } from "../context";
import { ENDPOINTS, apiFetch, errorMessage, queueFailure } from "../lib/api";
import { artistCredit } from "../lib/format";
import {
  pageSubtitle,
  searchInput,
  list,
  sectionHeader,
  stateError,
  stateMsg,
} from "../lib/styles";
import type { TrackItem } from "../lib/types";

interface HomeResponse {
  data?: {
    topTracks?: { data?: TrackItem[] };
    recentTracks?: { data?: TrackItem[] };
  };
}

interface AlbumCard {
  id: string;
  title: string;
  cover_art_url: string | null;
  artist: string;
}

// One card per release group, taken from the recent tracks, in the order they appear.
function albumsFromTracks(tracks: TrackItem[]): AlbumCard[] {
  const seen = new Map<string, AlbumCard>();
  for (const t of tracks) {
    const rg = t.release_group;
    if (!rg?.id || seen.has(rg.id)) continue;
    seen.set(rg.id, {
      id: rg.id,
      title: rg.title ?? "",
      cover_art_url: rg.cover_art_url ?? null,
      artist: artistCredit(t.artists),
    });
  }
  return [...seen.values()].slice(0, 12);
}

type ListState =
  | { kind: "message"; text: string; error?: boolean }
  | { kind: "library"; recent: TrackItem[]; top: TrackItem[] }
  | { kind: "tracks"; tracks: TrackItem[] };

export function SongsPage() {
  const { queue, player, songsVersion, openAlbum } = useApp();
  const loadQueue = queue.load;

  const [subtitle, setSubtitle] = useState("Loading…");
  const [listView, setListView] = useState<ListState>({
    kind: "message",
    text: "Loading tracks…",
  });
  const [query, setQuery] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Each home or search request takes a number. A response applies only if no newer request started.
  const listRequest = useRef(0);

  // The home view: recent and top tracks, five of each.
  const loadLibrary = useCallback(async () => {
    const id = ++listRequest.current;
    setListView({ kind: "message", text: "Loading tracks…" });
    try {
      const res = await apiFetch<HomeResponse>(ENDPOINTS.home());
      if (id !== listRequest.current) return;
      loadQueue();
      setSubtitle("");
      setListView({
        kind: "library",
        recent: res.data?.recentTracks?.data ?? [],
        top: res.data?.topTracks?.data ?? [],
      });
    } catch (e) {
      if (id !== listRequest.current) return;
      setSubtitle("error");
      setListView({
        kind: "message",
        text: `Failed to load: ${errorMessage(e)}`,
        error: true,
      });
    }
  }, [loadQueue]);

  const runSearch = useCallback(
    async (value: string) => {
      if (!value.trim()) {
        void loadLibrary();
        return;
      }
      const id = ++listRequest.current;
      setListView({ kind: "message", text: "Searching…" });
      try {
        const res = await apiFetch<TrackItem[] | { data?: TrackItem[] }>(
          ENDPOINTS.searchTracks(value),
        );
        if (id !== listRequest.current) return;
        const tracks = Array.isArray(res) ? res : (res.data ?? []);
        setSubtitle(
          `${tracks.length} result${tracks.length !== 1 ? "s" : ""} for "${value}"`,
        );
        setListView(
          tracks.length
            ? { kind: "tracks", tracks }
            : { kind: "message", text: "No results found." },
        );
      } catch (e) {
        if (id !== listRequest.current) return;
        setSubtitle("error");
        setListView({
          kind: "message",
          text: `Search failed: ${errorMessage(e)}`,
          error: true,
        });
      }
    },
    [loadLibrary],
  );

  // Loads on mount, and again after an import bumps songsVersion.
  useEffect(() => {
    void loadLibrary();
  }, [songsVersion, loadLibrary]);

  useEffect(() => () => clearTimeout(searchTimer.current), []);

  // The tracks currently listed: search results, or the recent songs on the home view.
  const shown =
    listView.kind === "tracks"
      ? listView.tracks
      : listView.kind === "library"
        ? listView.recent
        : [];
  const playShown = async (shuffle: boolean) => {
    try {
      await player.playTracksNow(
        shown.map((t) => t.id),
        shuffle,
      );
    } catch (e) {
      alert(queueFailure(e));
    }
  };

  useEffect(() => {
    const onSearch = (event: Event) => {
      const value = (event as CustomEvent<string>).detail ?? "";
      setQuery(value);
      void runSearch(value);
    };
    window.addEventListener("sonora-search", onSearch);
    return () => window.removeEventListener("sonora-search", onSearch);
  }, [runSearch]);

  const onSearch = (e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => void runSearch(value), 300);
  };

  return (
    <>
      <PageHeader title={listView.kind === "library" ? "Home" : "Songs"} />
      <div className={pageSubtitle}>{subtitle}</div>
      <input
        placeholder="Search songs…"
        value={query}
        onChange={onSearch}
        className={searchInput}
      />
      {shown.length > 0 && (
        <div className="list-actions">
          <button
            className="pill-button red"
            onClick={() => void playShown(false)}
          >
            <Icon name="play" size={14} /> Play
          </button>
          <button className="pill-button" onClick={() => void playShown(true)}>
            <Icon name="shuffle" size={14} /> Shuffle
          </button>
        </div>
      )}
      {listView.kind === "message" && (
        <div className={`${stateMsg} ${listView.error ? stateError : ""}`}>
          {listView.text}
        </div>
      )}
      {listView.kind === "library" && (
        <>
          {albumsFromTracks(listView.recent).length > 0 && (
            <section className="home-section">
              <div className="section-eyebrow">Recently Added</div>
              <h2 className="section-title">
                Albums <Icon name="chevron" size={22} />
              </h2>
              <div className="carousel">
                {albumsFromTracks(listView.recent).map((a) => (
                  <div
                    key={a.id}
                    className="carousel-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => openAlbum(a)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") openAlbum(a);
                    }}
                  >
                    <span className="carousel-art">
                      <CoverImage
                        src={a.cover_art_url}
                        loading="lazy"
                        fallback={<Icon name="disc" size={36} />}
                      />
                    </span>
                    <strong>{a.title}</strong>
                    <small>{a.artist}</small>
                  </div>
                ))}
              </div>
            </section>
          )}
          {listView.top.length > 0 && (
            <section className="home-section">
              <div className="section-eyebrow">For You</div>
              <h2 className="section-title">
                Top Songs <Icon name="chevron" size={22} />
              </h2>
              <div className={list}>
                {listView.top.slice(0, 5).map((t) => (
                  <TrackRow key={t.id} track={t} />
                ))}
              </div>
            </section>
          )}
          {listView.recent.length > 0 && (
            <section className="home-section">
              <div className="section-eyebrow">Recently Added</div>
              <h2 className="section-title">
                Songs <Icon name="chevron" size={22} />
              </h2>
              <div className={list}>
                {listView.recent.slice(0, 5).map((t) => (
                  <TrackRow key={t.id} track={t} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
      {listView.kind === "tracks" && (
        <div className={list}>
          {listView.tracks.map((t) => (
            <TrackRow key={t.id} track={t} />
          ))}
        </div>
      )}
    </>
  );
}
