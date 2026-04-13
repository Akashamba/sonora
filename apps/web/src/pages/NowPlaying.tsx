import { useEffect, useState } from "react";
import { usePlayerStore } from "../store/audio-store";

const NowPlaying = () => {
  const [metadata, setMetadata] = useState<any>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showQueue, setSetShowQueue] = useState(false);
  const { play, pause, next, prev, paused } = usePlayerStore();
  const currentTrackId = usePlayerStore((s) => s.currentTrackId);

  useEffect(() => {
    fetch(`/tracks/${currentTrackId}/metadata`)
      .then((res) => res.json())
      .then((json) => {
        setMetadata(json.data);
      });
  }, [currentTrackId]);

  if (!fullscreen) {
    return (
      <div
        className="flex justify-center fixed bottom-10 left-0 w-full bg-[#ba9b46] text-white py-3"
        onClick={() => setFullscreen((prev) => !prev)}
      >
        miniplayer
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
