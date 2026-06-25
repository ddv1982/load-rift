import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { LoadRiftApiProvider } from "./lib/loadrift/context";
import type { LoadRiftApi } from "./lib/loadrift/api";
import { createTauriLoadRiftApi } from "./lib/tauri/client";
import "./styles/app.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

function createRuntimeApi(): LoadRiftApi {
  if (
    import.meta.env.VITE_LOADRIFT_E2E === "true" &&
    window.__LOADRIFT_E2E_API__
  ) {
    return window.__LOADRIFT_E2E_API__;
  }

  return createTauriLoadRiftApi();
}

const api = createRuntimeApi();

createRoot(rootElement).render(
  <StrictMode>
    <LoadRiftApiProvider api={api}>
      <App />
    </LoadRiftApiProvider>
  </StrictMode>,
);
