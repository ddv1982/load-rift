import { useCallback, useEffect, useState } from "react";
import { useLoadRiftApi } from "../../lib/loadrift/context";
import {
  DEFAULT_LIVE_METRICS,
  type K6Options,
  type LiveMetrics,
  type TestCompletion,
  type TestResult,
  type TestStatus,
} from "../../lib/loadrift/types";
import { getTauriErrorMessage } from "../../lib/tauri/errors";

export interface TestHarnessState {
  status: TestStatus;
  metrics: LiveMetrics;
  result: TestResult | null;
  finishReason: string | null;
  error: string | null;
  output: string;
  isStarting: boolean;
  isBusy: boolean;
  isRunning: boolean;
}

const INITIAL_STATE: TestHarnessState = {
  status: "idle",
  metrics: DEFAULT_LIVE_METRICS,
  result: null,
  finishReason: null,
  error: null,
  output: "",
  isStarting: false,
  isBusy: false,
  isRunning: false,
};

export function useTestHarness() {
  const api = useLoadRiftApi();
  const [state, setState] = useState<TestHarnessState>(INITIAL_STATE);

  useEffect(() => {
    const unlistenCallbacks: Array<() => void> = [];
    let isActive = true;

    async function registerListeners() {
      const unlistenOutput = await api.onK6Output((data) => {
        if (!isActive) {
          return;
        }

        setState((previous) => ({
          ...previous,
          output: `${previous.output}${data}`,
        }));
      });

      if (!isActive) {
        unlistenOutput();
        return;
      }

      unlistenCallbacks.push(unlistenOutput);

      const unlistenMetrics = await api.onK6Metrics((metrics) => {
        if (!isActive) {
          return;
        }

        setState((previous) => ({
          ...previous,
          metrics,
        }));
      });

      if (!isActive) {
        unlistenMetrics();
        return;
      }

      unlistenCallbacks.push(unlistenMetrics);

      const unlistenComplete = await api.onK6Complete((completion: TestCompletion) => {
        if (!isActive) {
          return;
        }

        setState((previous) => ({
          ...previous,
          status: completion.runState,
          metrics: completion.metrics,
          result: completion.result,
          finishReason: completion.finishReason,
          error: null,
          isStarting: false,
          isBusy: false,
          isRunning: false,
        }));
      });

      if (!isActive) {
        unlistenComplete();
        return;
      }

      unlistenCallbacks.push(unlistenComplete);

      const unlistenError = await api.onK6Error((error) => {
        if (!isActive) {
          return;
        }

        setState((previous) => ({
          ...previous,
          status: "failed",
          finishReason: "execution_error",
          error,
          isStarting: false,
          isBusy: false,
          isRunning: false,
        }));
      });

      if (!isActive) {
        unlistenError();
        return;
      }

      unlistenCallbacks.push(unlistenError);
    }

    void registerListeners();

    return () => {
      isActive = false;
      for (const unlisten of unlistenCallbacks) {
        unlisten();
      }
    };
  }, [api]);

  const refreshStatus = useCallback(async () => {
    setState((previous) => ({
      ...previous,
      isBusy: true,
      error: null,
    }));

    try {
      const status = await api.getTestStatus();

      setState((previous) => ({
        ...previous,
        status: status.status,
        metrics: status.metrics ?? DEFAULT_LIVE_METRICS,
        result: status.result ?? null,
        finishReason: status.finishReason ?? null,
        error: status.errorMessage ?? null,
        isStarting: false,
        isBusy: false,
        isRunning: status.isRunning,
      }));
    } catch (error) {
      setState((previous) => ({
        ...previous,
        isBusy: false,
        isStarting: false,
        error: getTauriErrorMessage(
          error,
          "Failed to load the current test status.",
        ),
      }));
    }
  }, [api]);

  const startTest = useCallback(
    async (options: K6Options) => {
      setState((previous) => ({
        ...previous,
        metrics: DEFAULT_LIVE_METRICS,
        result: null,
        finishReason: null,
        error: null,
        output: "",
        isStarting: true,
        isBusy: true,
        isRunning: false,
      }));

      try {
        await api.startTest({ options });
        setState((previous) => ({
          ...previous,
          status: "running",
          isStarting: false,
          isBusy: false,
          isRunning: true,
        }));
      } catch (error) {
        setState((previous) => ({
          ...previous,
          status: "failed",
          error: getTauriErrorMessage(error, "Failed to start the k6 test."),
          isStarting: false,
          isBusy: false,
          isRunning: false,
        }));
      }
    },
    [api],
  );

  const stopTest = useCallback(async () => {
    setState((previous) => ({
      ...previous,
      isStarting: false,
      isBusy: true,
      error: null,
    }));

    try {
      await api.stopTest();
      setState((previous) => ({
        ...previous,
        status: "stopped",
        finishReason: "stopped",
        isStarting: false,
        isBusy: false,
        isRunning: false,
      }));
    } catch (error) {
      setState((previous) => ({
        ...previous,
        isStarting: false,
        isBusy: false,
        error: getTauriErrorMessage(error, "Failed to stop the k6 test."),
      }));
    }
  }, [api]);

  return {
    state,
    refreshStatus,
    startTest,
    stopTest,
  };
}
