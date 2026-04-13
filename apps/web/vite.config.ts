import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  server: {
    proxy: {
      "/home": "http://localhost:3000",
      "/release-group": "http://localhost:3000",
      "/tracks": "http://localhost:3000",
    },
  },
  base: "/preview/",
  plugins: [react(), tailwindcss()],
});
