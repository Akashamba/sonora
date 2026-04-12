import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Song from "./pages/Song.tsx";
import NowPlaying from "./pages/NowPlaying.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/song/:id" element={<Song />} />
        <Route path="/now-playing" element={<NowPlaying />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
