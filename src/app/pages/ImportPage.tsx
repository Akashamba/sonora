import { useEffect, useState } from "react";
import { ENDPOINTS, apiFetch, apiRequest, errorMessage } from "../lib/api";
import { CoverImage } from "../components/CoverImage";
import { Icon } from "../components/Icon";
import { useApp } from "../context";
import type { TrackItem } from "../lib/types";

// The standard thumbnail URL for a video. The title comes from the server's preview.
const youtubeThumb = (id: string) =>
  `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

const POLL_MS = 1200;
const POLL_MAX_MS = 15000;
const MAX_POLL_ERRORS = 10;

type Preview = {
  url: string;
  kind: "single" | "album" | "playlist";
  title: string | null;
  uploader: string | null;
  entryCount: number;
  entries: {
    position: number;
    youtubeId: string;
    title: string;
    durationMs: number;
    inLibrary: boolean;
  }[];
  albumCandidates: {
    releaseId: string;
    releaseGroupId: string;
    title: string;
    artist: string;
    date: string | null;
    country: string | null;
    trackCount: number;
    disambiguation: string | null;
    coverArtUrl: string | null;
    score: number;
  }[];
  recommendation: { mode: "album" | "playlist" | "single"; releaseId?: string };
  needsConfirmation: boolean;
};
type ImportRecord = {
  id: string;
  mode: string;
  title: string | null;
  sourceUrl: string;
  playlistId: string | null;
  createdAt: number;
  counts: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
  };
  jobs?: {
    id: string;
    position: number;
    status: string;
    error: string | null;
    trackId: string | null;
  }[];
};

export function ImportPage() {
  const { player } = useApp();
  const [url, setUrl] = useState("");
  // Entry titles at submit time, keyed by position. The job list only has ids and statuses.
  const [jobTitles, setJobTitles] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selection, setSelection] = useState<{
    mode: "single" | "album" | "playlist";
    releaseId?: string;
  } | null>(null);
  const [savePlaylist, setSavePlaylist] = useState(false);
  const [playlistName, setPlaylistName] = useState("");
  const [activeImport, setActiveImport] = useState<ImportRecord | null>(null);
  const [connection, setConnection] = useState<"ok" | "reconnecting" | "lost">(
    "ok",
  );
  const [recent, setRecent] = useState<ImportRecord[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const loadRecent = async () => {
    try {
      const res = await apiFetch<{ data?: ImportRecord[] }>(
        ENDPOINTS.imports(),
      );
      setRecent(res.data ?? []);
    } catch {
      setRecent([]);
    }
  };
  useEffect(() => {
    void loadRecent();
  }, []);
  // Polls the active import. A failed poll is retried with backoff; only a run of
  // MAX_POLL_ERRORS failures in a row stops it. Polling stops when the import finishes.
  useEffect(() => {
    const importId = activeImport?.id;
    if (!importId) return;
    setConnection("ok");
    let errors = 0;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const res = await apiFetch<{ data: ImportRecord }>(
          ENDPOINTS.importStatus(importId),
        );
        if (stopped) return;
        errors = 0;
        setConnection("ok");
        setActiveImport(res.data);
        if (res.data.counts.queued + res.data.counts.running === 0) {
          void loadRecent();
          return;
        }
      } catch {
        if (stopped) return;
        errors += 1;
        if (errors >= MAX_POLL_ERRORS) {
          setConnection("lost");
          return;
        }
        setConnection("reconnecting");
      }
      timer = window.setTimeout(
        poll,
        Math.min(POLL_MS * 2 ** errors, POLL_MAX_MS),
      );
    };
    timer = window.setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [activeImport?.id]);

  const inspect = async () => {
    if (!url.trim()) {
      setStatus("Paste a YouTube URL to preview it.");
      return;
    }
    setBusy(true);
    setStatus("Checking the URL…");
    setPreview(null);
    setSelection(null);
    setActiveImport(null);
    try {
      const res = await apiRequest(ENDPOINTS.importPreview(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const body = (await res.json()) as { data: Preview };
      setPreview(body.data);
      const rec = body.data.recommendation;
      setSelection({ mode: rec.mode, releaseId: rec.releaseId });
      setSavePlaylist(body.data.kind === "playlist");
      setPlaylistName(body.data.title || "Imported playlist");
      setStatus("");
    } catch (e) {
      setStatus(
        `Preview unavailable: ${errorMessage(e)}. You can still submit this URL directly.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    const chosen = selection ?? { mode: "single" as const };
    setBusy(true);
    setStatus("Starting import…");
    try {
      const res = await apiRequest(ENDPOINTS.importUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          mode: chosen.mode,
          releaseId: chosen.releaseId,
          playlist: savePlaylist
            ? {
                create: true,
                name: playlistName || preview?.title || "Imported playlist",
              }
            : undefined,
        }),
      });
      const body = (await res.json()) as {
        data?: { importId?: string };
        importId?: string;
        message?: string;
      };
      const id = body.data?.importId ?? body.importId;
      setStatus(body.message ?? "Import started.");
      setJobTitles(
        Object.fromEntries(
          (preview?.entries ?? []).map((e) => [e.position, e.title]),
        ),
      );
      if (id) {
        try {
          const progress = await apiFetch<{ data: ImportRecord }>(
            ENDPOINTS.importStatus(id),
          );
          setActiveImport(progress.data);
        } catch {
          setActiveImport({
            id,
            mode: chosen.mode,
            title: preview?.title ?? null,
            sourceUrl: url,
            playlistId: null,
            createdAt: Date.now(),
            counts: { queued: 1, running: 0, completed: 0, failed: 0 },
          });
        }
      }
      setPreview(null);
      await loadRecent();
    } catch (e) {
      setStatus(`Import failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const mode = selection?.mode ?? preview?.recommendation.mode;
  const singleEntry =
    preview?.kind === "single" ? preview.entries[0] : undefined;
  const previewHeading =
    preview?.title ||
    preview?.entries?.[0]?.title ||
    (preview?.kind === "single" ? "YouTube video" : "Ready to import");
  // Plays a job's track. The job has only the id, so the metadata comes first.
  const playJobTrack = async (trackId: string) => {
    // Must run before the fetch below, while the tap still counts as a user gesture.
    player.unlockAudio();
    try {
      const res = await apiFetch<{ data: TrackItem }>(
        ENDPOINTS.getTrackMetadata(trackId),
      );
      player.playFromList(res.data);
    } catch (e) {
      alert(`Could not play track: ${errorMessage(e)}`);
    }
  };
  const fmtDate = (n: number) => new Date(n).toLocaleString();

  return (
    <section className="music-page import-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Add to your collection</p>
          <h1>Import</h1>
          <p className="page-description">
            Bring in a song, album, or playlist from YouTube.
          </p>
        </div>
      </header>
      <div className="import-form">
        <label htmlFor="import-url">YouTube URL</label>
        <div className="url-row">
          <input
            id="import-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://youtube.com/watch?v=…"
            onKeyDown={(e) => {
              if (e.key === "Enter") void inspect();
            }}
          />
          <button
            className="pill-button red"
            disabled={busy}
            onClick={() => void inspect()}
          >
            Preview
          </button>
        </div>
        {status && <p className="notice">{status}</p>}
      </div>
      {status.startsWith("Preview unavailable") && (
        <button
          className="pill-button red"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await apiRequest(ENDPOINTS.importUrl(), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: url.trim() }),
              });
              setStatus("Import started.");
              await loadRecent();
            } catch (e) {
              setStatus(`Import failed: ${errorMessage(e)}`);
            } finally {
              setBusy(false);
            }
          }}
        >
          Import without preview
        </button>
      )}

      {preview && (
        <div className="preview-panel">
          <div className="preview-heading">
            {singleEntry && (
              <div className="preview-thumb">
                <CoverImage
                  src={youtubeThumb(singleEntry.youtubeId)}
                  loading="lazy"
                  fallback={<Icon name="note" size={28} />}
                />
              </div>
            )}
            <div>
              <p className="eyebrow">
                {preview.kind === "single" ? "Single video" : preview.kind}
              </p>
              <h2>{previewHeading}</h2>
              <p>
                {preview.uploader || "YouTube"} · {preview.entryCount}{" "}
                {preview.entryCount === 1 ? "song" : "songs"}
              </p>
            </div>
          </div>
          {preview.needsConfirmation ? (
            <div className="candidate-list">
              {preview.albumCandidates.map((candidate) => (
                <button
                  key={candidate.releaseId}
                  className={`candidate-card ${selection?.releaseId === candidate.releaseId ? "selected" : ""}`}
                  onClick={() =>
                    setSelection({
                      mode: "album",
                      releaseId: candidate.releaseId,
                    })
                  }
                >
                  <div className="candidate-art">
                    <CoverImage src={candidate.coverArtUrl} fallback={null} />
                  </div>
                  <div className="candidate-info">
                    <strong>{candidate.title}</strong>
                    <span>
                      {candidate.artist}{" "}
                      {candidate.date ? `· ${candidate.date.slice(0, 4)}` : ""}
                    </span>
                    <small>
                      {candidate.trackCount} tracks vs {preview.entryCount}{" "}
                      videos
                      {candidate.disambiguation
                        ? ` · ${candidate.disambiguation}`
                        : ""}
                    </small>
                  </div>
                  <span className="candidate-radio">
                    {selection?.releaseId === candidate.releaseId ? "●" : "○"}
                  </span>
                </button>
              ))}
              <button
                className={`candidate-card playlist-choice ${selection?.mode === "playlist" ? "selected" : ""}`}
                onClick={() => setSelection({ mode: "playlist" })}
              >
                <div className="candidate-art playlist-choice-art">♫</div>
                <div className="candidate-info">
                  <strong>Import as a playlist</strong>
                  <span>Match each song on its own</span>
                  <small>{preview.entryCount} videos</small>
                </div>
                <span className="candidate-radio">
                  {selection?.mode === "playlist" ? "●" : "○"}
                </span>
              </button>
            </div>
          ) : (
            <div className="recommendation-line">
              <span>
                Recommended:{" "}
                {mode === "album"
                  ? "Match as an album"
                  : mode === "playlist"
                    ? "Import as a playlist"
                    : "Import this song"}
              </span>
              <button
                className="pill-button red"
                disabled={busy}
                onClick={() => void submit()}
              >
                Import
              </button>
            </div>
          )}
          {preview.kind !== "single" && (
            <div className="playlist-save-option">
              <label>
                <input
                  type="checkbox"
                  checked={savePlaylist}
                  onChange={(e) => setSavePlaylist(e.target.checked)}
                />{" "}
                Also save as a Sonora playlist
              </label>
              {savePlaylist && (
                <input
                  className="playlist-name-input"
                  value={playlistName}
                  onChange={(e) => setPlaylistName(e.target.value)}
                  aria-label="Playlist name"
                />
              )}
            </div>
          )}
          {preview.needsConfirmation && (
            <button
              className="pill-button red import-confirm"
              disabled={busy || !selection}
              onClick={() => void submit()}
            >
              Import selection
            </button>
          )}
        </div>
      )}

      {activeImport && (
        <section className="progress-panel">
          <p className="eyebrow">Import progress</p>
          <h2>{activeImport.title || jobTitles[0] || "Import"}</h2>
          {connection === "reconnecting" && (
            <p className="notice">Connection lost. Reconnecting…</p>
          )}
          {connection === "lost" && (
            <p className="notice error-notice">
              Stopped checking this import. Reload the page to see its progress.
            </p>
          )}
          <div className="import-counts">
            <span>{activeImport.counts.queued} queued</span>
            <span>{activeImport.counts.running} running</span>
            <span>{activeImport.counts.completed} completed</span>
            <span>{activeImport.counts.failed} failed</span>
          </div>
          {activeImport.jobs && (
            <ol className="import-job-list">
              {activeImport.jobs.map((job) => (
                <li key={job.id} className="import-job">
                  <span className="job-index">{job.position + 1}</span>
                  <div className="job-main">
                    <span className="job-title">
                      {jobTitles[job.position] || `Video ${job.position + 1}`}
                    </span>
                    {job.error && (
                      <small className="job-error">{job.error}</small>
                    )}
                  </div>
                  <span className={`status-pill status-${job.status}`}>
                    {job.status}
                  </span>
                  {job.trackId ? (
                    <button
                      className="text-button job-track"
                      onClick={() => void playJobTrack(job.trackId!)}
                    >
                      Play
                    </button>
                  ) : (
                    <span className="job-track" />
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      <section className="recent-imports">
        <h2>Recent imports</h2>
        {recent.length ? (
          <div>
            {recent.map((item) => (
              <article className="recent-import-row" key={item.id}>
                <div>
                  <strong>{item.title || item.sourceUrl}</strong>
                  <small>
                    {item.mode} · {fmtDate(item.createdAt)}
                  </small>
                </div>
                <div className="recent-counts">
                  {item.counts.completed} done · {item.counts.failed} failed ·{" "}
                  {item.counts.queued + item.counts.running} active
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted-copy">
            Recent import history is unavailable or empty.
          </p>
        )}
      </section>
    </section>
  );
}
