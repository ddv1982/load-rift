import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { LoadRiftApiProvider } from "./lib/loadrift/context";
import { createTauriLoadRiftApi } from "./lib/tauri/client";
import "./styles/app.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

const api = createTauriLoadRiftApi();

createRoot(rootElement).render(
  <StrictMode>
    <LoadRiftApiProvider api={api}>
      <App />
    </LoadRiftApiProvider>
  </StrictMode>,
);
