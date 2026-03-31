import { useCallback, useState } from "react";
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
  const [state, setState] = useState<SmokeTestState>(INITIAL_STATE);

  const runSmokeTest = useCallback(
    async (options: K6Options) => {
      setState({
        isRunning: true,
        result: null,
        error: null,
      });

      try {
        const result = await api.smokeTestRequests({ options });
        setState({
          isRunning: false,
          result,
          error: null,
        });
      } catch (error) {
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
    setState(INITIAL_STATE);
  }, []);

  return {
    state,
    runSmokeTest,
    clearSmokeTest,
  };
}
