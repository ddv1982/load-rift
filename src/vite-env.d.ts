/// <reference types="vite/client" />

import type { LoadRiftApi } from "./lib/loadrift/api";

declare global {
  interface ImportMetaEnv {
    readonly VITE_LOADRIFT_E2E?: string;
  }

  interface Window {
    __LOADRIFT_E2E_API__?: LoadRiftApi;
  }
}

export {};
