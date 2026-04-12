import { useEffect, useRef, useState } from "react";

const NowPlaying = () => {
  const [metadata, setMetadata] = useState<any>(null);
  const [nextLoaded, setNextLoaded] = useState(false);
  const playerRef1 = useRef<HTMLAudioElement>(null);
  const playerRef2 = useRef<HTMLAudioElement>(null);

  // on mount, fetch next track and play it on player 1
  useEffect(() => {
    if (playerRef1.current) {
      fetch("/tracks/next")
        .then((res) => res.json())
        .then((json) => {
          playerRef1.current!.src = `/tracks/${json.data.track_id}/stream`;
          playerRef1.current?.play().catch(() => {});
          fetch(`/tracks/${json.data.track_id}/metadata`)
            .then((res) => res.json())
            .then((json) => setMetadata(json.data));
        });
    }
  }, []);

  // when less than 30 seconds left on current player, fetch and load next player
  const loadNext = (e: any) => {
    if (nextLoaded) return;
    if (e.target.duration - e.target.currentTime < 30) {
      fetch("/tracks/next")
        .then((res) => res.json())
        .then((json) => {
          if (e.target === playerRef1.current) {
            playerRef2.current!.src = `/tracks/${json.data.track_id}/stream`;
            playerRef2.current?.load();
          } else {
            playerRef1.current!.src = `/tracks/${json.data.track_id}/stream`;
            playerRef1.current?.load();
          }
          setNextLoaded(true);
        });
    }
  };

  const handleEnded = () => {
    if (playerRef1.current?.ended) {
      console.log("playerRef2.current.ended", playerRef2.current!.ended);
      playerRef2.current?.play();
    }
    if (playerRef2.current?.ended) {
      playerRef1.current?.play();
    }
    setNextLoaded(false);
  };

  return (
    <>
      The world is yours scarface
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
      <audio
        ref={playerRef1}
        controls
        onEnded={handleEnded}
        onTimeUpdate={loadNext}
      />
      <audio
        ref={playerRef2}
        controls
        onEnded={handleEnded}
        onTimeUpdate={loadNext}
      />
    </>
  );
};

export default NowPlaying;

// as soon as user clicks "now playing", all audio components are unlocked
// when the first component ends, start playing the second component
// when second ends, start playing first component again
