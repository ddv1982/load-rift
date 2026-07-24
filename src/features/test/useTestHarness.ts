import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadRiftApi } from "../../lib/loadrift/api";
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

interface PendingCommand {
  id: number;
  kind: "start" | "stop";
  apiGeneration: number;
  authorityGeneration: number;
  detached: boolean;
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
  const commandSequenceRef = useRef(0);
  const startSequenceRef = useRef(0);
  const pendingCommandRef = useRef<PendingCommand | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const terminalErrorRunIdRef = useRef<string | null>(null);
  const listenerErrorRef = useRef<string | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const authorityGenerationRef = useRef(0);
  const refreshSequenceRef = useRef(0);
  const pendingRefreshIdRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const apiRef = useRef(api);
  const apiGenerationRef = useRef(0);
  const previousApiRef = useRef(api);
  if (apiRef.current !== api) {
    apiRef.current = api;
    apiGenerationRef.current += 1;
  }

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadCurrentStatus = useCallback(
    async (
      statusApi: LoadRiftApi,
      commandSequence = commandSequenceRef.current,
    ) => {
      if (
        !mountedRef.current ||
        commandSequenceRef.current !== commandSequence ||
        (pendingCommandRef.current?.apiGeneration ===
          apiGenerationRef.current &&
          apiRef.current === statusApi)
      ) {
        return;
      }

      const refreshId = refreshSequenceRef.current + 1;
      refreshSequenceRef.current = refreshId;
      pendingRefreshIdRef.current = refreshId;
      const lifecycleGeneration = lifecycleGenerationRef.current;
      const apiGeneration = apiGenerationRef.current;

      setState((previous) => ({
        ...previous,
        isBusy: true,
        error: previous.error ?? listenerErrorRef.current,
      }));

      const isCurrentRequest = () =>
        mountedRef.current &&
        apiRef.current === statusApi &&
        apiGenerationRef.current === apiGeneration &&
        refreshSequenceRef.current === refreshId &&
        lifecycleGenerationRef.current === lifecycleGeneration &&
        commandSequenceRef.current === commandSequence;
      const clearPendingRefresh = () => {
        if (pendingRefreshIdRef.current === refreshId) {
          pendingRefreshIdRef.current = null;
        }
      };

      try {
        const status = normalizeGetTestStatusResponse(
          await statusApi.getTestStatus(),
        );
        if (!isCurrentRequest()) {
          clearPendingRefresh();
          return;
        }

        clearPendingRefresh();
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
          error: status.errorMessage ?? listenerErrorRef.current,
          runId: status.runId,
          isStarting: false,
          isBusy: false,
          isRunning: status.isRunning,
        }));
      } catch (error) {
        if (!isCurrentRequest()) {
          clearPendingRefresh();
          return;
        }

        clearPendingRefresh();
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
    },
    [],
  );

  useEffect(() => {
    const unlistenCallbacks: Array<() => void> = [];
    let isActive = true;
    const apiChanged = previousApiRef.current !== api;
    previousApiRef.current = api;
    const pendingCommand = pendingCommandRef.current;

    if (apiChanged) {
      if (
        pendingCommand &&
        pendingCommand.apiGeneration !== apiGenerationRef.current
      ) {
        pendingCommand.detached = true;
        pendingCommandRef.current = null;
      }
      void loadCurrentStatus(api, commandSequenceRef.current);
    }

    function cleanupListeners() {
      for (const unlisten of unlistenCallbacks.splice(0)) {
        try {
          unlisten();
        } catch {
          // Continue cleaning up the remaining listeners.
        }
      }
    }

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

        if (
          !activeRunIdRef.current &&
          pendingCommandRef.current?.kind !== "start" &&
          !terminalErrorRunIdRef.current
        ) {
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

      const unlistenComplete = await api.onK6Complete(
        (completion: TestCompletion) => {
          const normalizedCompletion = normalizeTestCompletion(completion);
          if (
            !normalizedCompletion ||
            !isActive ||
            !isCurrentRun(normalizedCompletion.runId)
          ) {
            return;
          }

          activeRunIdRef.current = null;
          terminalErrorRunIdRef.current =
            normalizedCompletion.runState === "failed"
              ? normalizedCompletion.runId
              : null;
          pendingCommandRef.current = null;
          authorityGenerationRef.current += 1;
          lifecycleGenerationRef.current += 1;
          setState((previous) => ({
            ...previous,
            status: normalizedCompletion.runState,
            metrics: normalizedCompletion.metrics,
            result: normalizedCompletion.result,
            finishReason: normalizedCompletion.finishReason,
            resultSource: normalizedCompletion.resultSource,
            summaryIssue: normalizedCompletion.summaryIssue,
            error:
              normalizedCompletion.errorMessage ?? listenerErrorRef.current,
            runId: normalizedCompletion.runId,
            isStarting: false,
            isBusy: false,
            isRunning: false,
          }));
        },
      );

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

        const preserveCompletionError =
          terminalErrorRunIdRef.current === errorEvent.runId;
        activeRunIdRef.current = null;
        terminalErrorRunIdRef.current = null;
        pendingCommandRef.current = null;
        authorityGenerationRef.current += 1;
        lifecycleGenerationRef.current += 1;
        setState((previous) => ({
          ...previous,
          status: "failed",
          finishReason: "execution_error",
          error:
            preserveCompletionError && previous.error
              ? previous.error
              : errorEvent.message,
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
      const listenerError = listenerErrorRef.current;
      listenerErrorRef.current = null;
      if (listenerError) {
        setState((previous) =>
          previous.error === listenerError
            ? { ...previous, error: null }
            : previous,
        );
      }
    }

    void registerListeners().catch((error: unknown) => {
      cleanupListeners();
      if (!isActive || !mountedRef.current) {
        return;
      }

      isActive = false;
      const listenerError = getTauriErrorMessage(
        error,
        "Failed to register k6 event listeners.",
      );
      const previousListenerError = listenerErrorRef.current;
      listenerErrorRef.current = listenerError;
      setState((previous) => ({
        ...previous,
        error:
          !previous.error || previous.error === previousListenerError
            ? listenerError
            : previous.error,
      }));
    });

    return () => {
      isActive = false;
      lifecycleGenerationRef.current += 1;
      cleanupListeners();
    };
  }, [api, loadCurrentStatus]);

  const refreshStatus = useCallback(
    () => loadCurrentStatus(api),
    [api, loadCurrentStatus],
  );

  const startTest = useCallback(
    async (options: K6Options) => {
      if (!mountedRef.current) {
        return;
      }

      if (
        pendingCommandRef.current?.apiGeneration === apiGenerationRef.current
      ) {
        return;
      }

      const startId = startSequenceRef.current + 1;
      startSequenceRef.current = startId;
      const commandSequence = commandSequenceRef.current + 1;
      commandSequenceRef.current = commandSequence;
      const command: PendingCommand = {
        id: commandSequence,
        kind: "start",
        apiGeneration: apiGenerationRef.current,
        authorityGeneration: authorityGenerationRef.current,
        detached: false,
      };
      lifecycleGenerationRef.current += 1;
      const lifecycleGeneration = lifecycleGenerationRef.current;
      pendingCommandRef.current = command;
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
        error: listenerErrorRef.current,
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
        if (
          pendingCommandRef.current !== command ||
          lifecycleGenerationRef.current !== lifecycleGeneration ||
          commandSequenceRef.current !== commandSequence
        ) {
          if (
            mountedRef.current &&
            command.authorityGeneration === authorityGenerationRef.current &&
            (command.detached ||
              command.apiGeneration !== apiGenerationRef.current)
          ) {
            await loadCurrentStatus(apiRef.current, commandSequence);
          }
          return;
        }

        if (!mountedRef.current) {
          return;
        }

        const activeRunId = response.runId;
        activeRunIdRef.current = activeRunId;
        terminalErrorRunIdRef.current = null;
        pendingCommandRef.current = null;
        setState((previous) => ({
          ...previous,
          runId: activeRunId,
          status: "running",
          isStarting: false,
          isBusy: false,
          isRunning: true,
        }));
      } catch (error) {
        if (
          pendingCommandRef.current !== command ||
          lifecycleGenerationRef.current !== lifecycleGeneration ||
          commandSequenceRef.current !== commandSequence
        ) {
          if (
            mountedRef.current &&
            command.authorityGeneration === authorityGenerationRef.current &&
            (command.detached ||
              command.apiGeneration !== apiGenerationRef.current)
          ) {
            await loadCurrentStatus(apiRef.current, commandSequence);
          }
          return;
        }

        if (!mountedRef.current) {
          return;
        }

        activeRunIdRef.current = null;
        terminalErrorRunIdRef.current = null;
        pendingCommandRef.current = null;
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
    [api, loadCurrentStatus],
  );

  const stopTest = useCallback(async () => {
    if (
      !mountedRef.current ||
      pendingCommandRef.current?.apiGeneration === apiGenerationRef.current
    ) {
      return;
    }

    const commandSequence = commandSequenceRef.current + 1;
    commandSequenceRef.current = commandSequence;
    const command: PendingCommand = {
      id: commandSequence,
      kind: "stop",
      apiGeneration: apiGenerationRef.current,
      authorityGeneration: authorityGenerationRef.current,
      detached: false,
    };
    const lifecycleGeneration = lifecycleGenerationRef.current;
    pendingCommandRef.current = command;
    setState((previous) => ({
      ...previous,
      isStarting: false,
      isBusy: true,
      error: listenerErrorRef.current,
    }));

    try {
      await api.stopTest();
      if (
        !mountedRef.current ||
        pendingCommandRef.current !== command ||
        lifecycleGenerationRef.current !== lifecycleGeneration ||
        commandSequenceRef.current !== commandSequence
      ) {
        if (
          mountedRef.current &&
          command.authorityGeneration === authorityGenerationRef.current &&
          (command.detached ||
            command.apiGeneration !== apiGenerationRef.current)
        ) {
          await loadCurrentStatus(apiRef.current, commandSequence);
        }
        return;
      }

      activeRunIdRef.current = null;
      terminalErrorRunIdRef.current = null;
      pendingCommandRef.current = null;
      lifecycleGenerationRef.current += 1;
      setState((previous) => ({
        ...previous,
        status: "stopped",
        finishReason: "stopped",
        isStarting: false,
        isBusy: false,
        isRunning: false,
      }));
    } catch (error) {
      if (
        !mountedRef.current ||
        pendingCommandRef.current !== command ||
        lifecycleGenerationRef.current !== lifecycleGeneration ||
        commandSequenceRef.current !== commandSequence
      ) {
        if (
          mountedRef.current &&
          command.authorityGeneration === authorityGenerationRef.current &&
          (command.detached ||
            command.apiGeneration !== apiGenerationRef.current)
        ) {
          await loadCurrentStatus(apiRef.current, commandSequence);
        }
        return;
      }

      pendingCommandRef.current = null;
      setState((previous) => ({
        ...previous,
        isStarting: false,
        isBusy: false,
        error: getTauriErrorMessage(error, "Failed to stop the k6 test."),
      }));
    }
  }, [api, loadCurrentStatus]);

  const clearTestState = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }

    startSequenceRef.current += 1;
    commandSequenceRef.current += 1;
    authorityGenerationRef.current += 1;
    lifecycleGenerationRef.current += 1;
    refreshSequenceRef.current += 1;
    activeRunIdRef.current = null;
    terminalErrorRunIdRef.current = null;
    pendingCommandRef.current = null;
    pendingRefreshIdRef.current = null;
    setState({ ...INITIAL_STATE, error: listenerErrorRef.current });
  }, []);

  return {
    state,
    refreshStatus,
    startTest,
    stopTest,
    clearTestState,
  };
}
