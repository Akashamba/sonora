import { useCallback, useEffect, useRef, useState } from "react";
import {
  ENDPOINTS,
  apiFetch,
  apiRequest,
  errorMessage,
  postQueue,
} from "../lib/api";
import { artistCredit } from "../lib/format";
import type { TrackItem } from "../lib/types";
import type { Nav } from "./useNav";
import type { Queue } from "./useQueue";

interface TrackResponse {
  data: TrackItem;
}

interface NextTrackResponse {
  data: { track_id: string };
}

const MAX_AUTO_SKIPS = 3;
const DEFAULT_VOLUME = 0.8;
// 0.1 s of silence. Gives a fresh <audio> element something to play during the unlock tap.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

// Keeps the browser <audio> element, the Media Session (lock screen) integration, and the
// now-playing state in one place. The <audio> element itself is rendered by App.
export function usePlayer(nav: Nav, queue: Queue) {
  const audioRef = useRef<HTMLAudioElement>(null);

  const [track, setTrack] = useState<TrackItem | null>(null);
  const [liked, setLiked] = useState(false);
  const [cover, setCover] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Set when the last stream failed to load. `title` is the track that failed.
  const [loadError, setLoadError] = useState<{ title: string } | null>(null);
  // Shared by both volume sliders. The element's own volume is set to match.
  const [volume, setVolumeState] = useState(DEFAULT_VOLUME);
  // The id of the track now shown, so async results (like) apply only to that track.
  const currentId = useRef<string | null>(null);
  // Bumped by every load request. Only the latest request may load a track.
  const loadSeq = useRef(0);

  const audio = () => audioRef.current!;

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = DEFAULT_VOLUME;
  }, []);

  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    if (audioRef.current) audioRef.current.volume = v;
  }, []);

  // Safari (iPhone) only starts play() inside a user gesture, and the track that follows a tap
  // loads after network round trips. Starting and pausing the shared element inside the tap
  // unlocks it for those later play() calls. Call this synchronously, before any await.
  const unlockAudio = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (!el.getAttribute("src")) el.src = SILENT_WAV;
    el.play().catch(() => {});
    el.pause();
  }, []);

  // Only the thumbnail URL is ever set. A track without cover art leaves the previous art in place,
  // as the vanilla version did.
  const updatePlayer = useCallback((t: TrackItem) => {
    currentId.current = t.id;
    setTrack(t);
    setLiked(Boolean(t.liked));
    const thumb = t.release_group?.cover_art_url_thumbnail_small;
    if (thumb) setCover(thumb);
  }, []);

  const setMediaMetadata = useCallback((t: TrackItem) => {
    if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined")
      return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: artistCredit(t.artists),
      album: t.release_group?.title ?? "",
      artwork: [
        {
          src: t.release_group?.cover_art_url_thumbnail_small ?? "",
          sizes: "512x512",
          type: "image/jpeg",
        },
      ],
    });
  }, []);

  const updatePositionState = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    const dur = el.duration;
    setCurrentTime(Number.isFinite(el.currentTime) ? el.currentTime : 0);
    setDuration(Number.isFinite(dur) ? dur : 0);
    if (!("mediaSession" in navigator)) return;
    // setPositionState throws unless duration is finite and positive
    if (!dur || !isFinite(dur)) return;
    navigator.mediaSession.setPositionState({
      duration: dur,
      playbackRate: el.playbackRate || 1,
      position: Math.min(el.currentTime, dur),
    });
  }, []);

  const play = useCallback(() => {
    audio()
      .play()
      .catch((err) => console.warn("Playback failed:", err));
  }, []);

  const pause = useCallback(() => {
    audio().pause();
  }, []);

  const togglePlayPause = useCallback(() => {
    if (audio().paused) play();
    else pause();
  }, [play, pause]);

  const seekRelative = useCallback((secs: number) => {
    const el = audio();
    el.currentTime = Math.max(
      0,
      Math.min(el.currentTime + secs, el.duration || 0),
    );
  }, []);

  const seekTo = useCallback((secs: number) => {
    const el = audio();
    el.currentTime = Math.max(0, Math.min(secs, el.duration || 0));
  }, []);

  // Cancels the load in progress. A newer load calls it first. The cancelled promise resolves
  // without touching the now-playing state, so no caller is left waiting forever.
  const pendingLoad = useRef<(() => void) | null>(null);

  // Points the element at a stream. The now-playing state changes only once the stream can play,
  // so a track that fails to load never shows up with the previous track's audio.
  const loadTrack = useCallback(
    (t: TrackItem) =>
      new Promise<void>((resolve, reject) => {
        const el = audio();
        pendingLoad.current?.();
        const detach = () => {
          el.removeEventListener("canplay", onReady);
          el.removeEventListener("error", onError);
          if (pendingLoad.current === cancel) pendingLoad.current = null;
        };
        const onReady = () => {
          detach();
          updatePlayer(t);
          setMediaMetadata(t);
          setLoadError(null);
          // A blocked or aborted play() is not a failed stream, so it does not count as an error.
          el.play().catch((err) => console.warn("Autoplay blocked:", err));
          resolve();
        };
        const onError = () => {
          detach();
          reject(new Error(`stream failed for ${t.id}`));
        };
        const cancel = () => {
          detach();
          resolve();
        };
        pendingLoad.current = cancel;
        el.addEventListener("canplay", onReady);
        el.addEventListener("error", onError);
        el.src = ENDPOINTS.streamTrack(t.id);
        el.load();
      }),
    [updatePlayer, setMediaMetadata],
  );

  // Pops the top of the queue (or history) and plays it. After a load failure on "next",
  // it skips ahead, at most MAX_AUTO_SKIPS times in a row, so a run of unplayable files stops
  // instead of looping.
  // A request that a newer one has superseded stops after each await. Its popped track is skipped:
  // a Next tap during a pending advance means "skip the one that is loading".
  const playServerTrack = useCallback(
    async (
      path: string,
      attempt: number,
      pop: () => Promise<NextTrackResponse> = () =>
        apiFetch<NextTrackResponse>(path),
    ): Promise<void> => {
      const seq = ++loadSeq.current;
      let meta: TrackItem | undefined;
      try {
        const next = await pop();
        if (seq !== loadSeq.current) return;
        queue.load();
        meta = (
          await apiFetch<TrackResponse>(
            ENDPOINTS.getTrackMetadata(next.data.track_id),
          )
        ).data;
        if (seq !== loadSeq.current) return;
        await loadTrack(meta);
      } catch (err) {
        if (seq !== loadSeq.current) return;
        console.warn("Failed to play track:", err);
        setLoadError({ title: meta?.title ?? "Unknown track" });
        if (path === ENDPOINTS.nextTrackId() && attempt < MAX_AUTO_SKIPS)
          await playServerTrack(path, attempt + 1);
      }
    },
    [queue, loadTrack],
  );

  // Plays a row from a list. The row already has the full track, so no metadata fetch is needed.
  // A load failure skips ahead the same way a failed "next" does.
  const playFromList = useCallback(
    (song: TrackItem) => {
      unlockAudio();
      loadSeq.current++;
      loadTrack(song).catch((err) => {
        console.warn("Failed to play track:", err);
        setLoadError({ title: song.title });
        void playServerTrack(ENDPOINTS.nextTrackId(), 1);
      });
    },
    [loadTrack, playServerTrack, unlockAudio],
  );

  const playNext = useCallback(
    () => playServerTrack(ENDPOINTS.nextTrackId(), 0),
    [playServerTrack],
  );

  // Up Next tap: the server drops the rows above `position` and pops that row, so the answer is
  // the track to play. It never retries: the row is already gone once the server has answered.
  const playFromUpNext = useCallback(
    (position: number) => {
      unlockAudio();
      void playServerTrack(ENDPOINTS.queuePlayFrom(), 0, async () => {
        const res = await apiRequest(ENDPOINTS.queuePlayFrom(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ position }),
        });
        return (await res.json()) as NextTrackResponse;
      });
    },
    [playServerTrack, unlockAudio],
  );

  const playPrevious = useCallback(
    () => playServerTrack(ENDPOINTS.prevTrackId(), 0),
    [playServerTrack],
  );

  // Starts the first track of a queue write (Play, Shuffle, album or playlist queue). The write
  // put that track at the top, so popping the queue plays it and removes it, with no duplicate.
  const playFromQueue = useCallback(() => playNext(), [playNext]);

  // Puts the tracks at the top of the queue, then plays the first of them.
  const playTracksNow = useCallback(
    async (trackIds: string[], shuffle = false) => {
      unlockAudio();
      await postQueue(ENDPOINTS.queueTracks(), { trackIds, shuffle });
      await playNext();
    },
    [playNext, unlockAudio],
  );

  // Next and previous buttons: stop, rewind, then load the other track.
  const skipNext = useCallback(() => {
    unlockAudio();
    pause();
    audio().currentTime = 0;
    void playNext();
  }, [unlockAudio, pause, playNext]);

  const skipPrevious = useCallback(() => {
    unlockAudio();
    pause();
    audio().currentTime = 0;
    void playPrevious();
  }, [unlockAudio, pause, playPrevious]);

  // Like button. Flips at once, then applies the server's answer, or flips back on failure.
  // Results apply only while the same track is shown. A 403 means demo mode.
  const toggleLike = useCallback(() => {
    if (!track) return;
    const id = track.id;
    const previous = liked;
    const isCurrent = () => currentId.current === id;
    setLiked(!previous);
    apiRequest(ENDPOINTS.toggleLikeTrack(id), { method: "POST" })
      .then((r) => r.json() as Promise<{ data: { liked: boolean } }>)
      .then((r) => {
        if (isCurrent()) setLiked(r.data.liked);
      })
      .catch((e: unknown) => {
        if (isCurrent()) setLiked(previous);
        if (errorMessage(e) === "403")
          alert("Likes are disabled in demo mode.");
      });
  }, [track, liked]);

  // Keep the latest handlers reachable from the Media Session and audio listeners,
  // which are attached once and would otherwise see stale closures.
  const latest = useRef({
    playNext,
    playPrevious,
    play,
    pause,
    seekRelative,
    updatePositionState,
  });
  useEffect(() => {
    latest.current = {
      playNext,
      playPrevious,
      play,
      pause,
      seekRelative,
      updatePositionState,
    };
  });

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const onPlay = () => {
      setPlaying(true);
      latest.current.updatePositionState();
    };
    const onPause = () => {
      setPlaying(false);
      latest.current.updatePositionState();
    };
    const onEnded = () => {
      setPlaying(false);
      void latest.current.playNext();
    };
    const onPosition = () => latest.current.updatePositionState();

    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("timeupdate", onPosition);
    el.addEventListener("loadedmetadata", onPosition);
    el.addEventListener("ratechange", onPosition);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("timeupdate", onPosition);
      el.removeEventListener("loadedmetadata", onPosition);
      el.removeEventListener("ratechange", onPosition);
    };
  }, []);

  // Lock screen controls. Seek-forward and seek-backward are left unregistered, as the vanilla version did.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler("nexttrack", () => void latest.current.playNext());
    ms.setActionHandler(
      "previoustrack",
      () => void latest.current.playPrevious(),
    );
    ms.setActionHandler("pause", () => latest.current.pause());
    ms.setActionHandler("play", () => latest.current.play());
    ms.setActionHandler("seekto", (details) => {
      if (details.seekTime == null) return;
      const el = audioRef.current!;
      const fast = el as HTMLAudioElement & { fastSeek?: (t: number) => void };
      if (details.fastSeek && fast.fastSeek) fast.fastSeek(details.seekTime);
      else el.currentTime = details.seekTime;
      latest.current.updatePositionState();
    });
  }, []);

  return {
    audioRef,
    track,
    liked,
    cover,
    playing,
    currentTime,
    duration,
    loadError,
    volume,
    setVolume,
    unlockAudio,
    playFromList,
    playFromUpNext,
    playFromQueue,
    playTracksNow,
    togglePlayPause,
    seekRelative,
    seekTo,
    skipNext,
    skipPrevious,
    toggleLike,
  };
}

export type Player = ReturnType<typeof usePlayer>;
