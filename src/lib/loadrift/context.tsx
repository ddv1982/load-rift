import { createContext, useContext, type PropsWithChildren } from "react";
import type { LoadRiftApi } from "./api";

const LoadRiftApiContext = createContext<LoadRiftApi | null>(null);

export function LoadRiftApiProvider({
  api,
  children,
}: PropsWithChildren<{ api: LoadRiftApi }>) {
  return (
    <LoadRiftApiContext.Provider value={api}>
      {children}
    </LoadRiftApiContext.Provider>
  );
}

export function useLoadRiftApi(): LoadRiftApi {
  const api = useContext(LoadRiftApiContext);

  if (!api) {
    throw new Error("LoadRiftApiProvider is missing from the React tree.");
  }

  return api;
}
