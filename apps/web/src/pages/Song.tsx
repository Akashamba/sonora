import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

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

const Song = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [song, setSong] = useState<any>(null);

  useEffect(() => {
    fetch(`/tracks/${id}/metadata`)
      .then((res) => res.json())
      .then((json) => {
        // console.log(json);
        setSong(json.data);
      });
  }, []);

  if (!song)
    return <div style={{ padding: 24 }}>Song not found for id: {id}</div>;

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: 24 }}>
      <button onClick={() => navigate(-1)}>&larr; Back</button>
      <div
        style={{
          marginTop: 24,
          display: "flex",
          gap: 24,
          alignItems: "flex-start",
        }}
      >
        <img
          src={song.release_group.cover_art_url_thumbnail_small}
          alt=""
          width={120}
          height={120}
        />
        <div>
          <h1 style={{ margin: 0 }}>{song.title}</h1>
          <p style={{ margin: "8px 0 4px", color: "#888" }}>
            {formatArtists(song.artists)}
          </p>
          <p style={{ margin: 0, color: "#aaa" }}>
            Album: {song.release_group.title}
          </p>
          <p style={{ margin: 0, color: "#aaa" }}>
            Duration: {formatMs(song.length)}
          </p>
          <p style={{ margin: 0, color: "#aaa" }}>Position: #{song.position}</p>
          <p style={{ margin: 0, color: "#aaa" }}>
            Liked: {song.liked ? "Yes" : "No"}
          </p>
        </div>
      </div>
    </div>
  );
};

export default Song;

