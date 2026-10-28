import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ENDPOINTS } from "./lib/api";
import type { AppConfig } from "./lib/types";
import "./styles.css";

const DEFAULT_CONFIG: AppConfig = { SHOW_MODAL: false };

// Read the server config first, so the demo modal state is known before the first render.
async function loadConfig(): Promise<AppConfig> {
  try {
    const r = await fetch(ENDPOINTS.config());
    return r.ok ? ((await r.json()) as AppConfig) : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

const root = createRoot(document.getElementById("root")!);
loadConfig().then((config) => root.render(<App config={config} />));
