import { useEffect, useState, useRef } from "react";
import { usePlayerStore } from "../store/audio-store";
import { artistCredit } from "../utils/artistCredit";

const NowPlaying = () => {
  const [metadata, setMetadata] = useState<any>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showQueue, setSetShowQueue] = useState(false);
  const { play, pause, next, prev, paused } = usePlayerStore();
  const currentTrackId = usePlayerStore((s) => s.currentTrackId);
  const playRef = useRef(play);
  const pauseRef = useRef(pause);
  const nextRef = useRef(next);
  const prevRef = useRef(prev);

  useEffect(() => {
    playRef.current = play;
    pauseRef.current = pause;
    nextRef.current = next;
    prevRef.current = prev;
  }, [play, pause, next, prev]);

  // attach play and pause to navigator api after first interaction
  useEffect(() => {
    const addControls = () => {
      if ("mediaSession" in navigator) {
        console.log("play activated");
        navigator.mediaSession.setActionHandler("play", playRef.current);
        navigator.mediaSession.setActionHandler("pause", pauseRef.current);
        navigator.mediaSession.setActionHandler("nexttrack", nextRef.current);
        navigator.mediaSession.setActionHandler(
          "previoustrack",
          prevRef.current,
        );

        window.removeEventListener("keydown", addControls);
        window.removeEventListener("click", addControls);
      }
    };

    window.addEventListener("keydown", addControls);
    window.addEventListener("click", addControls);
  }, []);

  useEffect(() => {
    fetch(`/tracks/${currentTrackId}/metadata`)
      .then((res) => res.json())
      .then((json) => {
        setMetadata(json.data);
      });
  }, [currentTrackId]);

  useEffect(() => {
    if (metadata) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: metadata.title,
        artist: artistCredit(metadata.artists),
        album: metadata.release_group.title,
        artwork: [
          {
            src: metadata.release_group.cover_art_url_thumbnail_small ?? "",
            sizes: "512x512",
            type: "image/jpeg",
          },
        ],
      });
    }
  }, [metadata]);

  if (!fullscreen) {
    return (
      <div className="flex justify-between fixed bottom-10 left-0 w-full bg-[#ba9b46] text-white py-3">
        {metadata ? (
          <div onClick={() => setFullscreen((prev) => !prev)}>
            {metadata.title}
          </div>
        ) : (
          <div>Loading...</div>
        )}

        <div className="z-50">
          <button
            className="bg-gray-800 text-white px-4 rounded-md"
            onClick={prev}
          >
            Prev
          </button>
          <button
            className="bg-gray-800 text-white px-4 rounded-md"
            onClick={paused ? play : pause}
          >
            {paused ? "Play" : "Pause"}
          </button>
          <button
            className="bg-gray-800 text-white px-4 rounded-md"
            onClick={next}
          >
            Next
          </button>
        </div>
      </div>
    );
  }

  const Queue = () => {
    return (
      <div className="h-screen w-screen z-50">
        Queue
        <button
          onClick={() => setSetShowQueue((prev) => !prev)}
          className="bg-gray-800 text-white px-4 py-2 rounded-md"
        >
          Close Queue
        </button>
      </div>
    );
  };

  return (
    <div className="h-screen w-screen z-40">
      {metadata && (
        <div>
          <div className="track-cover">
            <img src={metadata.release_group.cover_art_url_thumbnail_small} />
          </div>
          <div className="track-info">
            <div className="track-title">{metadata.title}</div>
            <div className="track-artist">{metadata.artists[0].name}</div>
          </div>
        </div>
      )}
      {showQueue && <Queue />}

      <button
        className="bg-gray-800 text-white px-4 py-2 rounded-md"
        onClick={prev}
      >
        Prev
      </button>
      <button
        className="bg-gray-800 text-white px-4 py-2 rounded-md"
        onClick={paused ? play : pause}
      >
        {paused ? "Play" : "Pause"}
      </button>
      <button
        className="bg-gray-800 text-white px-4 py-2 rounded-md"
        onClick={next}
      >
        Next
      </button>

      <br />

      <button
        onClick={() => setFullscreen((prev) => !prev)}
        className="bg-gray-800 text-white px-4 py-2 rounded-md"
      >
        close full screen
      </button>
      <button
        onClick={() => setSetShowQueue((prev) => !prev)}
        className="bg-gray-800 text-white px-4 py-2 rounded-md"
      >
        Open Queue
      </button>
    </div>
  );
};

export default NowPlaying;
