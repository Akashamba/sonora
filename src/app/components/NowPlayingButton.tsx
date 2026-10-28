import { useApp } from "../context";

export function NowPlayingButton() {
  const { nav, player } = useApp();
  return (
    <button
      className={`now-playing ${player.playing ? "" : "paused"}`}
      onClick={() => nav.go("player-page")}
    >
      <span className="bars">
        <span />
        <span />
        <span />
      </span>
      Now Playing
    </button>
  );
}
