import { useCallback, useState } from "react";
import type { CollectionInfo } from "../../lib/loadrift/types";
import { useLoadRiftApi } from "../../lib/loadrift/context";
import { getTauriErrorMessage } from "../../lib/tauri/errors";

export interface ImportState {
  isLoading: boolean;
  error: string | null;
  collection: CollectionInfo | null;
}

export function useCollectionImport() {
  const api = useLoadRiftApi();
  const [state, setState] = useState<ImportState>({
    isLoading: false,
    error: null,
    collection: null,
  });

  const runImport = useCallback(
    async (load: () => Promise<CollectionInfo>) => {
      setState((previous) => ({
        ...previous,
        isLoading: true,
        error: null,
      }));

      try {
        const collection = await load();

        setState({
          isLoading: false,
          error: null,
          collection,
        });
      } catch (error) {
        setState((previous) => ({
          ...previous,
          isLoading: false,
          error: getTauriErrorMessage(
            error,
            "Collection import failed unexpectedly.",
          ),
        }));
      }
    },
    [],
  );

  const importFromFile = useCallback(
    async (filePath: string) => {
      await runImport(() => api.importCollectionFromFile({ filePath }));
    },
    [api, runImport],
  );

  const importFromUrl = useCallback(
    async (url: string) => {
      if (!url.trim()) {
        setState((previous) => ({
          ...previous,
          isLoading: false,
          error: "Enter a collection URL before importing.",
        }));
        return;
      }

      await runImport(() => api.importCollectionFromUrl({ url }));
    },
    [api, runImport],
  );

  const reportError = useCallback((message: string) => {
    setState((previous) => ({
      ...previous,
      isLoading: false,
      error: message,
    }));
  }, []);

  const reset = useCallback(() => {
    setState({
      isLoading: false,
      error: null,
      collection: null,
    });
  }, []);

  return {
    state,
    importFromFile,
    importFromUrl,
    reportError,
    reset,
  };
}
