import { useCallback, useRef, useState } from "react";
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
  const importRequestIdRef = useRef(0);
  const [state, setState] = useState<ImportState>({
    isLoading: false,
    error: null,
    collection: null,
  });

  const runImport = useCallback(
    async (load: () => Promise<CollectionInfo>) => {
      const requestId = importRequestIdRef.current + 1;
      importRequestIdRef.current = requestId;

      setState((previous) => ({
        ...previous,
        isLoading: true,
        error: null,
      }));

      try {
        const collection = await load();
        if (importRequestIdRef.current !== requestId) {
          return;
        }

        setState({
          isLoading: false,
          error: null,
          collection,
        });
      } catch (error) {
        if (importRequestIdRef.current !== requestId) {
          return;
        }

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

  const reportError = useCallback((message: string) => {
    importRequestIdRef.current += 1;
    setState((previous) => ({
      ...previous,
      isLoading: false,
      error: message,
    }));
  }, []);

  const reset = useCallback(() => {
    importRequestIdRef.current += 1;
    setState({
      isLoading: false,
      error: null,
      collection: null,
    });
  }, []);

  return {
    state,
    importFromFile,
    reportError,
    reset,
  };
}
