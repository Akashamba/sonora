import { useState, useEffect } from "react";
// import reactLogo from "./assets/react.svg";
// import viteLogo from "./assets/vite.svg";
// import heroImg from "./assets/hero.png";
import "./App.css";
import { Link } from "react-router-dom";

function formatArtists(artists: any[]) {
  return [...artists]
    .sort((a, b) => a.pos - b.pos)
    .map((a) => `${a.name}${a.joinphrase ?? ""}`)
    .join("");
}

function formatMs(ms: any) {
  const secs = Math.floor(ms / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

function SongRow({ song }: { song: any }) {
  return (
    <Link
      to={`/song/${song.id}`}
      state={{ song }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 0",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <img
        src={song.release_group.cover_art_url_thumbnail_small}
        alt=""
        width={48}
        height={48}
      />
      <div>
        <div style={{ fontWeight: "bold" }}>{song.title}</div>
        <div style={{ fontSize: 13, color: "#888" }}>
          {formatArtists(song.artists)}
        </div>
      </div>
      <div style={{ marginLeft: "auto", fontSize: 13, color: "#aaa" }}>
        {formatMs(song.length)}
      </div>
    </Link>
  );
}

function App() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch("/home")
      .then((res) => res.json())
      .then((json) => setData(json.data));
  }, []);

  if (!data) return <div>Loading...</div>;

  return (
    <>
      <section id="center">
        <div>
          <h1>Get started</h1>
          <p>
            Edit <code>src/App.tsx</code> and save to test <code>HMR</code>
          </p>
        </div>
      </section>

      <section id="center">
        <div style={{ maxWidth: 600, margin: "0 auto", padding: 24 }}>
          <h2>Top Tracks</h2>
          {data.topTracks.data.map((song: any) => (
            <SongRow key={song.id} song={song} />
          ))}

          <h2 style={{ marginTop: 32 }}>Recent Tracks</h2>
          {data.recentTracks.data.map((song: any) => (
            <SongRow key={song.id} song={song} />
          ))}
        </div>
      </section>
    </>
  );
}

export default App;
