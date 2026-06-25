import { useCallback, useEffect, useRef, useState } from "react";
import { useLoadRiftApi } from "../../lib/loadrift/context";
import { appendLogOutput } from "../../lib/loadrift/outputLog";
import {
  DEFAULT_LIVE_METRICS,
  normalizeGetTestStatusResponse,
  normalizeRunErrorEvent,
  normalizeRunMetricsEvent,
  normalizeStartTestResponse,
  normalizeTestCompletion,
  type K6Options,
  type LiveMetrics,
  type TestCompletion,
  type TestResult,
  type TestResultSource,
  type TestStatus,
} from "../../lib/loadrift/types";
import { getTauriErrorMessage } from "../../lib/tauri/errors";

export interface TestHarnessState {
  status: TestStatus;
  metrics: LiveMetrics;
  result: TestResult | null;
  finishReason: string | null;
  resultSource: TestResultSource | null;
  summaryIssue: string | null;
  error: string | null;
  runId: string | null;
  output: string;
  isStarting: boolean;
  isBusy: boolean;
  isRunning: boolean;
}

function createRunId(startId: number) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `loadrift-${Date.now()}-${startId}`;
}

const INITIAL_STATE: TestHarnessState = {
  status: "idle",
  metrics: DEFAULT_LIVE_METRICS,
  result: null,
  finishReason: null,
  resultSource: null,
  summaryIssue: null,
  error: null,
  runId: null,
  output: "",
  isStarting: false,
  isBusy: false,
  isRunning: false,
};

export function useTestHarness() {
  const api = useLoadRiftApi();
  const [state, setState] = useState<TestHarnessState>(INITIAL_STATE);
  const startSequenceRef = useRef(0);
  const pendingStartIdRef = useRef<number | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const terminalErrorRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    const unlistenCallbacks: Array<() => void> = [];
    let isActive = true;

    function isCurrentRun(runId: string) {
      return activeRunIdRef.current === runId;
    }

    function isAcceptedErrorRun(runId: string) {
      return isCurrentRun(runId) || terminalErrorRunIdRef.current === runId;
    }

    async function registerListeners() {
      const unlistenOutput = await api.onK6Output((data) => {
        if (!isActive || typeof data !== "string") {
          return;
        }

        setState((previous) => ({
          ...previous,
          output: appendLogOutput(previous.output, data),
        }));
      });

      if (!isActive) {
        unlistenOutput();
        return;
      }

      unlistenCallbacks.push(unlistenOutput);

      const unlistenMetrics = await api.onK6Metrics((event) => {
        const metricsEvent = normalizeRunMetricsEvent(event);
        if (!metricsEvent || !isActive || !isCurrentRun(metricsEvent.runId)) {
          return;
        }

        setState((previous) => ({
          ...previous,
          metrics: metricsEvent.metrics,
        }));
      });

      if (!isActive) {
        unlistenMetrics();
        return;
      }

      unlistenCallbacks.push(unlistenMetrics);

      const unlistenComplete = await api.onK6Complete((completion: TestCompletion) => {
        const normalizedCompletion = normalizeTestCompletion(completion);
        if (!normalizedCompletion || !isActive || !isCurrentRun(normalizedCompletion.runId)) {
          return;
        }

        activeRunIdRef.current = null;
        terminalErrorRunIdRef.current =
          normalizedCompletion.runState === "failed" ? normalizedCompletion.runId : null;
        pendingStartIdRef.current = null;
        setState((previous) => ({
          ...previous,
          status: normalizedCompletion.runState,
          metrics: normalizedCompletion.metrics,
          result: normalizedCompletion.result,
          finishReason: normalizedCompletion.finishReason,
          resultSource: normalizedCompletion.resultSource,
          summaryIssue: normalizedCompletion.summaryIssue,
          error: normalizedCompletion.errorMessage,
          runId: normalizedCompletion.runId,
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

      const unlistenError = await api.onK6Error((event) => {
        const errorEvent = normalizeRunErrorEvent(event);
        if (!errorEvent || !isActive || !isAcceptedErrorRun(errorEvent.runId)) {
          return;
        }

        activeRunIdRef.current = null;
        terminalErrorRunIdRef.current = null;
        pendingStartIdRef.current = null;
        setState((previous) => ({
          ...previous,
          status: "failed",
          finishReason: "execution_error",
          error: previous.error || errorEvent.message,
          runId: errorEvent.runId,
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
      const status = normalizeGetTestStatusResponse(await api.getTestStatus());
      activeRunIdRef.current = status.isRunning ? status.runId : null;
      terminalErrorRunIdRef.current = null;

      setState((previous) => ({
        ...previous,
        status: status.status,
        metrics: status.metrics ?? DEFAULT_LIVE_METRICS,
        result: status.result ?? null,
        finishReason: status.finishReason ?? null,
        resultSource: status.resultSource ?? null,
        summaryIssue: status.summaryIssue ?? null,
        error: status.errorMessage ?? null,
        runId: status.runId,
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
      const startId = startSequenceRef.current + 1;
      startSequenceRef.current = startId;
      pendingStartIdRef.current = startId;
      const runId = createRunId(startId);
      activeRunIdRef.current = runId;
      terminalErrorRunIdRef.current = null;

      setState((previous) => ({
        ...previous,
        metrics: DEFAULT_LIVE_METRICS,
        result: null,
        finishReason: null,
        resultSource: null,
        summaryIssue: null,
        error: null,
        output: "",
        runId,
        isStarting: true,
        isBusy: true,
        isRunning: false,
      }));

      try {
        const response = normalizeStartTestResponse(
          await api.startTest({ options, runId }),
          runId,
        );
        if (pendingStartIdRef.current !== startId) {
          return;
        }

        const activeRunId = response.runId;
        activeRunIdRef.current = activeRunId;
        terminalErrorRunIdRef.current = null;
        pendingStartIdRef.current = null;
        setState((previous) => ({
          ...previous,
          runId: activeRunId,
          status: "running",
          isStarting: false,
          isBusy: false,
          isRunning: true,
        }));
      } catch (error) {
        if (pendingStartIdRef.current !== startId) {
          return;
        }

        activeRunIdRef.current = null;
        terminalErrorRunIdRef.current = null;
        pendingStartIdRef.current = null;
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
      activeRunIdRef.current = null;
      terminalErrorRunIdRef.current = null;
      pendingStartIdRef.current = null;
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
