import { useState } from "react";
import { AlbumRow } from "../components/AlbumRow";
import { PageHeader } from "../components/PageHeader";
import { useLazyList } from "../hooks/useLazyList";
import { ENDPOINTS, apiFetch } from "../lib/api";
import {
  pageSubtitle,
  searchInput,
  stateError,
  stateMsg,
} from "../lib/styles";
import type { AlbumItem } from "../lib/types";

interface AlbumsResponse {
  release_groups?: AlbumItem[];
  albums?: AlbumItem[];
  data?: AlbumItem[];
}

async function fetchAlbums(): Promise<AlbumItem[]> {
  const data = await apiFetch<AlbumItem[] | AlbumsResponse>(ENDPOINTS.albums());
  return Array.isArray(data)
    ? data
    : (data.release_groups ?? data.albums ?? data.data ?? []);
}

export function AlbumsPage({ active }: { active: boolean }) {
  const { items, error } = useLazyList(active, fetchAlbums);
  const [query, setQuery] = useState("");

  // Client-side filter on title and type. Unlike a server search, it leaves no "no results" message.
  const q = query.toLowerCase();
  const visible = items?.filter((a) =>
    (a.title + " " + (a.musicbrainz_primary_type ?? ""))
      .toLowerCase()
      .includes(q),
  );

  return (
    <>
      <PageHeader title="Albums" />
      <div className={pageSubtitle}>
        {error
          ? "error"
          : items === null
            ? "Loading…"
            : `${items.length} releases`}
      </div>
      <input
        placeholder="Search albums…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className={searchInput}
      />
      {error ? (
        <div className={`${stateMsg} ${stateError}`}>
          Failed to load: {error}
        </div>
      ) : items === null ? (
        <div className={stateMsg}>Loading albums…</div>
      ) : items.length === 0 ? (
        <div className={stateMsg}>No albums found.</div>
      ) : (
        <div className="cover-grid">
          {visible?.map((a) => (
            <AlbumRow key={a.id} album={a} />
          ))}
        </div>
      )}
    </>
  );
}
