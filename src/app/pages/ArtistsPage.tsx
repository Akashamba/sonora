import { useState } from "react";
import { ArtistRow } from "../components/ArtistRow";
import { PageHeader } from "../components/PageHeader";
import { useLazyList } from "../hooks/useLazyList";
import { ENDPOINTS, apiFetch } from "../lib/api";
import {
  pageSubtitle,
  searchInput,
  stateError,
  stateMsg,
} from "../lib/styles";
import type { ArtistItem } from "../lib/types";

interface ArtistsResponse {
  artists?: ArtistItem[];
  data?: ArtistItem[];
}

async function fetchArtists(): Promise<ArtistItem[]> {
  const data = await apiFetch<ArtistItem[] | ArtistsResponse>(
    ENDPOINTS.artists(),
  );
  return Array.isArray(data) ? data : (data.artists ?? data.data ?? []);
}

export function ArtistsPage({ active }: { active: boolean }) {
  const { items, error } = useLazyList(active, fetchArtists);
  const [query, setQuery] = useState("");

  const q = query.toLowerCase();
  const visible = items?.filter((a) => a.name.toLowerCase().includes(q));

  return (
    <>
      <PageHeader title="Artists" />
      <div className={pageSubtitle}>
        {error
          ? "error"
          : items === null
            ? "Loading…"
            : `${items.length} artists`}
      </div>
      <input
        placeholder="Search artists…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className={searchInput}
      />
      {error ? (
        <div className={`${stateMsg} ${stateError}`}>
          Failed to load: {error}
        </div>
      ) : items === null ? (
        <div className={stateMsg}>Loading artists…</div>
      ) : items.length === 0 ? (
        <div className={stateMsg}>No artists found.</div>
      ) : (
        <div className="cover-grid artist-grid">
          {visible?.map((a) => (
            <ArtistRow key={a.id} artist={a} />
          ))}
        </div>
      )}
    </>
  );
}
