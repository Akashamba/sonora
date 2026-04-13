import { useEffect, useRef, useState } from "react";
// import { useAudioControlsStore } from "../store/audio-store";
// import UnlockAutoplay from "./UnlockAutoplay";

const AudioPlayer = () => {
  const playerRef1 = useRef<HTMLAudioElement>(null);
  const playerRef2 = useRef<HTMLAudioElement>(null);
  const [nextLoaded, setNextLoaded] = useState(false);
  const activePlayer = useRef<1 | 2>(1);

  // Fetch next track and assign it to active player
  const fetchNextTrackForPlayer = async (
    ref: React.RefObject<HTMLAudioElement>,
  ) => {
    if (playerRef1.current && playerRef2.current) {
      const res = await fetch("/tracks/next");
      const nextTrack = await res.json();
      ref.current.src = `/tracks/${nextTrack.data.track_id}/stream`;
      ref.current.load();
    }
  };

  // on mount:
  // fetch next track and load it on active player (on mount this will be player 1)
  useEffect(() => {
    const loadFirstTrack = async () => {
      // return early if refs haven't been assigned yet
      await fetchNextTrackForPlayer(
        playerRef1 as React.RefObject<HTMLAudioElement>,
      );
    };

    if (!playerRef1.current || !playerRef2.current) return;
    loadFirstTrack();
  }, []);

  // fetch next track and load it on inactive player
  const loadNextTrackForInactivePlayer = async () => {
    const inactivePlayerRef =
      activePlayer.current === 1 ? playerRef2 : playerRef1;
    await fetchNextTrackForPlayer(
      inactivePlayerRef as React.RefObject<HTMLAudioElement>,
    );
    setNextLoaded(true);
  };

  // when less than 30 seconds left on current player, fetch and load next player
  const handleTimeUpdate = async (
    e: React.SyntheticEvent<HTMLAudioElement>,
  ) => {
    if (nextLoaded) return;
    if (e.currentTarget.duration - e?.currentTarget.currentTime < 30) {
      await loadNextTrackForInactivePlayer();
    }
  };

  const handleEnded = (e: React.SyntheticEvent<HTMLAudioElement>) => {
    if (e.target === playerRef1.current) {
      activePlayer.current = 2;
      playerRef2.current?.play();
    } else {
      activePlayer.current = 1;
      playerRef1.current?.play();
    }
    setNextLoaded(false);
  };

  return (
    <>
      {/* <UnlockAutoplay /> */}
      <audio
        ref={playerRef1}
        controls
        onEnded={handleEnded}
        onTimeUpdate={handleTimeUpdate}
      />
      <audio
        ref={playerRef2}
        controls
        onEnded={handleEnded}
        onTimeUpdate={handleTimeUpdate}
      />
    </>
  );
};

export default AudioPlayer;
