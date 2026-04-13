import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Song from "./pages/Song.tsx";
import NowPlaying from "./pages/NowPlaying.tsx";
import Home from "./pages/Home.tsx";
import BottomNavigation from "./components/BottomNavigation.tsx";
// import SignIn from "./pages/SignIn.tsx";
import Library from "./pages/Library.tsx";
import Import from "./pages/Import.tsx";
import Search from "./pages/Search.tsx";
import Profile from "./pages/Profile.tsx";
import Album from "./pages/Album.tsx";
import Artist from "./pages/Artist.tsx";
import AudioPlayer from "./components/AudioPlayer.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* <SignIn /> */}

    {/* everything below should only render if signed in */}
    <AudioPlayer />
    <NowPlaying />
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <BottomNavigation />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/library" element={<Library />} />
        <Route path="/import" element={<Import />} />
        <Route path="/search" element={<Search />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/album/:id" element={<Album />} />
        <Route path="/artist/:id" element={<Artist />} />
        <Route path="/song/:id" element={<Song />} />
      </Routes>
    </BrowserRouter>
    <audio
      src="https://dl.espressif.com/dl/audio/ff-16b-2c-44100hz.mp3"
      controls
    />
  </StrictMode>,
);
