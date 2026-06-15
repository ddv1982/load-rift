import { useCallback, useRef, useState } from "react";
import { useLoadRiftApi } from "../../lib/loadrift/context";
import type { K6Options, SmokeTestResponse } from "../../lib/loadrift/types";
import { getTauriErrorMessage } from "../../lib/tauri/errors";

export interface SmokeTestState {
  isRunning: boolean;
  result: SmokeTestResponse | null;
  error: string | null;
}

const INITIAL_STATE: SmokeTestState = {
  isRunning: false,
  result: null,
  error: null,
};

export function useSmokeTest() {
  const api = useLoadRiftApi();
  const requestIdRef = useRef(0);
  const [state, setState] = useState<SmokeTestState>(INITIAL_STATE);

  const runSmokeTest = useCallback(
    async (options: K6Options) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      setState({
        isRunning: true,
        result: null,
        error: null,
      });

      try {
        const result = await api.smokeTestRequests({ options });
        if (requestIdRef.current !== requestId) {
          return;
        }

        setState({
          isRunning: false,
          result,
          error: null,
        });
      } catch (error) {
        if (requestIdRef.current !== requestId) {
          return;
        }

        setState({
          isRunning: false,
          result: null,
          error: getTauriErrorMessage(error, "Smoke test failed unexpectedly."),
        });
      }
    },
    [api],
  );

  const clearSmokeTest = useCallback(() => {
    requestIdRef.current += 1;
    setState(INITIAL_STATE);
  }, []);

  return {
    state,
    runSmokeTest,
    clearSmokeTest,
  };
}
