import { create } from "zustand";

type Controls = {
  play: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  paused: boolean;
  setPaused: (p: boolean) => void;
  currentTrackId: string;
  setCurrentTrackId: (id: string) => void;
  setControls: (c: Partial<Controls>) => void;
};

export const usePlayerStore = create<Controls>((set) => ({
  play: () => {},
  pause: () => {},
  next: () => {},
  prev: () => {},
  paused: true,
  setPaused: (p) => set({ paused: p }),
  currentTrackId: "",
  setCurrentTrackId: (id) => set({ currentTrackId: id }),
  setControls: (c) => set((s) => ({ ...s, ...c })),
}));
