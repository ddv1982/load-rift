import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LoadRiftApi } from "../../lib/loadrift/api";
import { LoadRiftApiProvider } from "../../lib/loadrift/context";
import {
  DEFAULT_LIVE_METRICS,
  type GetTestStatusResponse,
  type K6Options,
  type LiveMetrics,
  type RunErrorEvent,
  type RunMetricsEvent,
  type StartTestResponse,
  type TestCompletion,
  type TestResult,
} from "../../lib/loadrift/types";
import {
  createLoadRiftApiWrapper as createWrapper,
  deferred,
} from "../../test/loadRiftApiTestUtils";
import { useTestHarness } from "./useTestHarness";

const metrics: LiveMetrics = {
  activeVus: 2,
  totalRequests: 10,
  failedRequests: 1,
  errorRate: 0.1,
  avgResponseTime: 100,
  p50ResponseTime: 90,
  p95ResponseTime: 150,
  maxResponseTime: 180,
  requestsPerSecond: 5,
};

const startOptions: K6Options = {
  vus: 1,
  duration: "1s",
  rampUp: "instant",
  trafficMode: "sequential",
  rampUpTime: "1s",
  thresholds: {},
  requestHeaders: {},
  variableOverrides: {},
  advancedOptionsJson: "",
  selectedRequestIds: ["request-0"],
  requestWeights: {},
};

const resultPayload: TestResult = {
  status: "warning",
  metrics: {
    totalRequests: 10,
    failedRequests: 1,
    avgResponseTime: 100,
    p50ResponseTime: 90,
    p95ResponseTime: 150,
    maxResponseTime: 180,
    requestsPerSecond: 5,
  },
  thresholds: [],
};

function completionPayload(runId: string): TestCompletion {
  return {
    runId,
    runState: "completed",
    finishReason: "completed",
    metrics,
    result: resultPayload,
    resultSource: "summary",
    summaryIssue: null,
    errorMessage: null,
  };
}

function runningStatus(runId: string): GetTestStatusResponse {
  return {
    runId,
    status: "running",
    isRunning: true,
    metrics,
    result: null,
    finishReason: null,
    errorMessage: null,
    resultSource: null,
    summaryIssue: null,
  };
}

function idleStatus(): GetTestStatusResponse {
  return {
    runId: null,
    status: "idle",
    isRunning: false,
    metrics: null,
    result: null,
    finishReason: null,
    errorMessage: null,
    resultSource: null,
    summaryIssue: null,
  };
}

function createApiMock(overrides: Partial<LoadRiftApi> = {}) {
  const listeners: {
    output: ((payload: string) => void) | undefined;
    metrics: ((payload: RunMetricsEvent) => void) | undefined;
    complete: ((payload: TestCompletion) => void) | undefined;
    error: ((payload: RunErrorEvent) => void) | undefined;
  } = {
    output: undefined,
    metrics: undefined,
    complete: undefined,
    error: undefined,
  };

  const api: LoadRiftApi = {
    selectAndImportCollection: vi.fn(async () => null),
    validateTestConfiguration: vi.fn(),
    smokeTestRequests: vi.fn(),
    startTest: vi.fn(async (input: { options: K6Options; runId?: string }) => ({
      runId: input.runId ?? "test-run",
    })),
    stopTest: vi.fn(),
    selectAndExportReport: vi.fn(async () => null),
    getTestStatus: vi.fn(),
    onK6Output: vi.fn(async (callback: (payload: string) => void) => {
      listeners.output = callback;
      return () => {
        listeners.output = undefined;
      };
    }),
    onK6Metrics: vi.fn(async (callback: (payload: RunMetricsEvent) => void) => {
      listeners.metrics = callback;
      return () => {
        listeners.metrics = undefined;
      };
    }),
    onK6Complete: vi.fn(async (callback: (payload: TestCompletion) => void) => {
      listeners.complete = callback;
      return () => {
        listeners.complete = undefined;
      };
    }),
    onK6Error: vi.fn(async (callback: (payload: RunErrorEvent) => void) => {
      listeners.error = callback;
      return () => {
        listeners.error = undefined;
      };
    }),
    ...overrides,
  };

  return { api, listeners };
}

describe("useTestHarness", () => {
  it("hydrates state from refreshStatus", async () => {
    const statusResponse: GetTestStatusResponse = {
      runId: "status-run",
      status: "completed",
      isRunning: false,
      metrics,
      result: resultPayload,
      finishReason: "completed",
      errorMessage: null,
      resultSource: "summary",
      summaryIssue: null,
    };
    const { api } = createApiMock({
      getTestStatus: vi.fn(async () => statusResponse),
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(api.onK6Output).toHaveBeenCalled();
    });

    await act(async () => {
      await result.current.refreshStatus();
    });

    expect(result.current.state.runId).toBe("status-run");
    expect(result.current.state.status).toBe("completed");
    expect(result.current.state.metrics).toEqual(metrics);
    expect(result.current.state.result).toEqual(resultPayload);
    expect(result.current.state.finishReason).toBe("completed");
    expect(result.current.state.resultSource).toBe("summary");
    expect(result.current.state.summaryIssue).toBeNull();
    expect(result.current.state.isBusy).toBe(false);
    expect(result.current.state.isRunning).toBe(false);
  });

  it("ignores a stale refresh response after the current run completes", async () => {
    const statusRequest = deferred<GetTestStatusResponse>();
    const { api, listeners } = createApiMock({
      getTestStatus: vi.fn(() => statusRequest.promise),
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(listeners.complete).toBeTypeOf("function");
    });
    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const runId =
      vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

    let refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = result.current.refreshStatus();
      await Promise.resolve();
    });
    act(() => {
      listeners.complete?.(completionPayload(runId));
    });
    await act(async () => {
      statusRequest.resolve(runningStatus(runId));
      await refreshPromise;
    });

    expect(result.current.state.status).toBe("completed");
    expect(result.current.state.result).toEqual(resultPayload);
    expect(result.current.state.isRunning).toBe(false);
  });

  it("ignores a stale refresh response after a newer start", async () => {
    const statusRequest = deferred<GetTestStatusResponse>();
    const { api } = createApiMock({
      getTestStatus: vi.fn(() => statusRequest.promise),
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    let refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = result.current.refreshStatus();
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const runId =
      vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

    await act(async () => {
      statusRequest.resolve({
        ...runningStatus("old-run"),
        status: "completed",
        isRunning: false,
      });
      await refreshPromise;
    });

    expect(result.current.state.status).toBe("running");
    expect(result.current.state.runId).toBe(runId);
    expect(result.current.state.isRunning).toBe(true);
  });

  it("ignores a stale refresh response after a successful stop", async () => {
    const statusRequest = deferred<GetTestStatusResponse>();
    const { api } = createApiMock({
      getTestStatus: vi.fn(() => statusRequest.promise),
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const runId =
      vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";
    let refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = result.current.refreshStatus();
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.stopTest();
    });
    await act(async () => {
      statusRequest.resolve(runningStatus(runId));
      await refreshPromise;
    });

    expect(result.current.state.status).toBe("stopped");
    expect(result.current.state.finishReason).toBe("stopped");
    expect(result.current.state.isRunning).toBe(false);
  });

  it("blocks other commands while a start is pending on the current API", async () => {
    const startRequest = deferred<StartTestResponse>();
    const { api } = createApiMock({
      startTest: vi.fn(() => startRequest.promise),
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    let startPromise!: Promise<void>;
    let duplicateStartPromise!: Promise<void>;
    let stopPromise!: Promise<void>;
    await act(async () => {
      startPromise = result.current.startTest(startOptions);
      duplicateStartPromise = result.current.startTest(startOptions);
      stopPromise = result.current.stopTest();
      await Promise.resolve();
    });

    expect(api.startTest).toHaveBeenCalledOnce();
    expect(api.stopTest).not.toHaveBeenCalled();
    const runId = vi.mocked(api.startTest).mock.calls[0]![0].runId;

    await act(async () => {
      startRequest.resolve({ runId: "started-run" });
      await Promise.all([startPromise, duplicateStartPromise, stopPromise]);
    });

    expect(result.current.state.status).toBe("running");
    expect(result.current.state.runId).toBe(runId);
    expect(result.current.state.isBusy).toBe(false);
  });

  it("ignores a duplicate stop while the current stop is pending", async () => {
    const stopRequest = deferred<void>();
    const stopTest = vi
      .fn<LoadRiftApi["stopTest"]>()
      .mockReturnValueOnce(stopRequest.promise)
      .mockRejectedValueOnce(new Error("duplicate stop failed"));
    const { api } = createApiMock({ stopTest });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      await result.current.startTest(startOptions);
    });

    let firstStopPromise!: Promise<void>;
    let duplicateStopPromise!: Promise<void>;
    let startWhileStoppingPromise!: Promise<void>;
    await act(async () => {
      firstStopPromise = result.current.stopTest();
      duplicateStopPromise = result.current.stopTest();
      startWhileStoppingPromise = result.current.startTest(startOptions);
      await Promise.resolve();
    });

    expect(stopTest).toHaveBeenCalledOnce();
    expect(api.startTest).toHaveBeenCalledOnce();
    expect(result.current.state.isBusy).toBe(true);

    await act(async () => {
      stopRequest.resolve();
      await Promise.all([
        firstStopPromise,
        duplicateStopPromise,
        startWhileStoppingPromise,
      ]);
    });

    expect(result.current.state.status).toBe("stopped");
    expect(result.current.state.finishReason).toBe("stopped");
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.isBusy).toBe(false);
  });

  it("allows a stop retry after the current stop rejects", async () => {
    const stopTest = vi
      .fn<LoadRiftApi["stopTest"]>()
      .mockRejectedValueOnce(new Error("stop command unavailable"))
      .mockResolvedValueOnce();
    const { api } = createApiMock({ stopTest });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      await result.current.startTest(startOptions);
      await result.current.stopTest();
    });

    expect(stopTest).toHaveBeenCalledOnce();
    expect(result.current.state.error).toBe("stop command unavailable");
    expect(result.current.state.isRunning).toBe(true);
    expect(result.current.state.isBusy).toBe(false);

    await act(async () => {
      await result.current.stopTest();
    });

    expect(stopTest).toHaveBeenCalledTimes(2);
    expect(result.current.state.status).toBe("stopped");
    expect(result.current.state.finishReason).toBe("stopped");
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.isBusy).toBe(false);
  });

  it("ignores a stale refresh response after clearing", async () => {
    const statusRequest = deferred<GetTestStatusResponse>();
    const { api } = createApiMock({
      getTestStatus: vi.fn(() => statusRequest.promise),
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    let refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = result.current.refreshStatus();
      await Promise.resolve();
    });
    act(() => {
      result.current.clearTestState();
    });
    await act(async () => {
      statusRequest.resolve(runningStatus("cleared-run"));
      await refreshPromise;
    });

    expect(result.current.state).toMatchObject({
      status: "idle",
      runId: null,
      error: null,
      isBusy: false,
      isRunning: false,
    });
  });

  it("only applies the newest of overlapping refreshes", async () => {
    const firstRequest = deferred<GetTestStatusResponse>();
    const secondRequest = deferred<GetTestStatusResponse>();
    const getTestStatus = vi
      .fn<LoadRiftApi["getTestStatus"]>()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    const { api } = createApiMock({ getTestStatus });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    let firstRefresh!: Promise<void>;
    let secondRefresh!: Promise<void>;
    await act(async () => {
      firstRefresh = result.current.refreshStatus();
      secondRefresh = result.current.refreshStatus();
      await Promise.resolve();
    });
    await act(async () => {
      secondRequest.resolve(runningStatus("new-run"));
      await secondRefresh;
    });
    await act(async () => {
      firstRequest.resolve({
        ...runningStatus("old-run"),
        status: "failed",
        isRunning: false,
        errorMessage: "old status error",
      });
      await firstRefresh;
    });

    expect(result.current.state.status).toBe("running");
    expect(result.current.state.runId).toBe("new-run");
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.isBusy).toBe(false);
  });

  it("ignores a stale rejected refresh after a lifecycle transition", async () => {
    const statusRequest = deferred<GetTestStatusResponse>();
    const { api } = createApiMock({
      getTestStatus: vi.fn(() => statusRequest.promise),
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    let refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = result.current.refreshStatus();
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.startTest(startOptions);
    });
    await act(async () => {
      statusRequest.reject(new Error("stale status failure"));
      await refreshPromise;
    });

    expect(result.current.state.status).toBe("running");
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.isBusy).toBe(false);
  });

  it("surfaces a current refresh rejection", async () => {
    const { api } = createApiMock({
      getTestStatus: vi.fn(() =>
        Promise.reject(new Error("Status command unavailable")),
      ),
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      await result.current.refreshStatus();
    });

    expect(result.current.state.error).toBe("Status command unavailable");
    expect(result.current.state.isBusy).toBe(false);
  });

  it.each(["first", "last"] as const)(
    "catches a %s listener registration rejection and cleans registered listeners",
    async (failurePosition) => {
      const unlistenOutput = vi.fn();
      const unlistenMetrics = vi.fn();
      const unlistenComplete = vi.fn();
      const onK6Output = vi.fn(() =>
        failurePosition === "first"
          ? Promise.reject(new Error("Failed to register k6 event listeners."))
          : Promise.resolve(unlistenOutput),
      );
      const onK6Metrics = vi.fn(async () => unlistenMetrics);
      const onK6Complete = vi.fn(async () => unlistenComplete);
      const onK6Error = vi.fn(async () => {
        throw new Error("Error listener unavailable");
      });
      const { api } = createApiMock({
        onK6Output,
        onK6Metrics,
        onK6Complete,
        onK6Error,
      });
      const { result, unmount } = renderHook(() => useTestHarness(), {
        wrapper: createWrapper(api),
      });

      await waitFor(() => {
        expect(result.current.state.error).toBe(
          failurePosition === "first"
            ? "Failed to register k6 event listeners."
            : "Error listener unavailable",
        );
      });

      if (failurePosition === "first") {
        expect(onK6Metrics).not.toHaveBeenCalled();
        expect(unlistenOutput).not.toHaveBeenCalled();
      } else {
        expect(unlistenOutput).toHaveBeenCalledOnce();
        expect(unlistenMetrics).toHaveBeenCalledOnce();
        expect(unlistenComplete).toHaveBeenCalledOnce();
      }

      unmount();
    },
  );

  it("cleans partial listeners when middle registration rejects without corrupting an active run", async () => {
    const metricsRegistration = deferred<() => void>();
    const unlistenOutput = vi.fn();
    const onK6Complete = vi.fn(async () => vi.fn());
    const { api } = createApiMock({
      onK6Output: vi.fn(async () => unlistenOutput),
      onK6Metrics: vi.fn(() => metricsRegistration.promise),
      onK6Complete,
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(api.onK6Metrics).toHaveBeenCalledOnce();
    });
    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const runId = result.current.state.runId;
    await act(async () => {
      metricsRegistration.reject({ message: "Metrics listener denied" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.state.error).toBe("Metrics listener denied");
    });
    expect(unlistenOutput).toHaveBeenCalledOnce();
    expect(onK6Complete).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe("running");
    expect(result.current.state.runId).toBe(runId);
    expect(result.current.state.isRunning).toBe(true);
  });

  it("cleans a listener that resolves after unmount and stops registration", async () => {
    const outputRegistration = deferred<() => void>();
    const unlistenOutput = vi.fn();
    const { api } = createApiMock({
      onK6Output: vi.fn(() => outputRegistration.promise),
    });
    const { unmount } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(api.onK6Output).toHaveBeenCalledOnce();
    });
    unmount();
    await act(async () => {
      outputRegistration.resolve(unlistenOutput);
      await outputRegistration.promise;
      await Promise.resolve();
    });

    expect(unlistenOutput).toHaveBeenCalledOnce();
    expect(api.onK6Metrics).not.toHaveBeenCalled();
  });

  it("preserves a replacement listener failure after status hydration succeeds", async () => {
    const oldStatus = deferred<GetTestStatusResponse>();
    const replacementStatus = deferred<GetTestStatusResponse>();
    const { api: oldApi } = createApiMock({
      getTestStatus: vi.fn(() => oldStatus.promise),
    });
    const { api: newApi } = createApiMock({
      getTestStatus: vi.fn(() => replacementStatus.promise),
      onK6Metrics: vi.fn(() =>
        Promise.reject(new Error("replacement metrics listener denied")),
      ),
    });
    let currentApi = oldApi;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
      );
    }
    const { result, rerender } = renderHook(() => useTestHarness(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(oldApi.onK6Error).toHaveBeenCalledOnce();
    });
    let oldRefreshPromise!: Promise<void>;
    await act(async () => {
      oldRefreshPromise = result.current.refreshStatus();
      await Promise.resolve();
    });

    currentApi = newApi;
    rerender();
    await waitFor(() => {
      expect(result.current.state.error).toBe(
        "replacement metrics listener denied",
      );
    });

    await act(async () => {
      replacementStatus.resolve({
        runId: null,
        status: "idle",
        isRunning: false,
        metrics: null,
        result: null,
        finishReason: null,
        errorMessage: null,
        resultSource: null,
        summaryIssue: null,
      });
      await replacementStatus.promise;
    });
    await waitFor(() => {
      expect(result.current.state.isBusy).toBe(false);
    });
    expect(result.current.state.error).toBe(
      "replacement metrics listener denied",
    );

    await act(async () => {
      oldStatus.resolve(runningStatus("old-run"));
      await oldRefreshPromise;
    });
    expect(result.current.state.error).toBe(
      "replacement metrics listener denied",
    );
  });

  it.each([
    { refreshError: null, expectedError: null },
    {
      refreshError: "status remains unavailable",
      expectedError: "status remains unavailable",
    },
  ])(
    "clears a recovered listener failure without clearing another current error ($refreshError)",
    async ({ refreshError, expectedError }) => {
      const recoveredStatus = deferred<GetTestStatusResponse>();
      const { api: failingApi } = createApiMock({
        getTestStatus: vi.fn(() =>
          refreshError
            ? Promise.reject(new Error(refreshError))
            : Promise.resolve(runningStatus("unused-run")),
        ),
        onK6Output: vi.fn(() =>
          Promise.reject(new Error("listener registration unavailable")),
        ),
      });
      const { api: recoveredApi } = createApiMock({
        getTestStatus: vi.fn(() => recoveredStatus.promise),
      });
      let currentApi = failingApi;
      function Wrapper({ children }: PropsWithChildren) {
        return (
          <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
        );
      }
      const { result, rerender } = renderHook(() => useTestHarness(), {
        wrapper: Wrapper,
      });

      await waitFor(() => {
        expect(result.current.state.error).toBe(
          "listener registration unavailable",
        );
      });
      if (refreshError) {
        await act(async () => {
          await result.current.refreshStatus();
        });
        expect(result.current.state.error).toBe(refreshError);
      }

      currentApi = recoveredApi;
      rerender();
      await waitFor(() => {
        expect(recoveredApi.onK6Error).toHaveBeenCalledOnce();
      });

      expect(result.current.state.error).toBe(expectedError);

      await act(async () => {
        recoveredStatus.resolve(idleStatus());
        await recoveredStatus.promise;
      });
      await waitFor(() => {
        expect(result.current.state.isBusy).toBe(false);
      });
      expect(result.current.state.error).toBeNull();
    },
  );

  it("replaces consecutive listener failures and clears the latest one after recovery", async () => {
    const { api: apiA } = createApiMock({
      onK6Output: vi.fn(() => Promise.reject(new Error("listener A failed"))),
    });
    const { api: apiB } = createApiMock({
      getTestStatus: vi.fn(async () => idleStatus()),
      onK6Output: vi.fn(() => Promise.reject(new Error("listener B failed"))),
    });
    const { api: apiC } = createApiMock({
      getTestStatus: vi.fn(async () => idleStatus()),
    });
    let currentApi = apiA;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
      );
    }
    const { result, rerender } = renderHook(() => useTestHarness(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.state.error).toBe("listener A failed");
    });

    currentApi = apiB;
    rerender();
    await waitFor(() => {
      expect(result.current.state.error).toBe("listener B failed");
    });

    currentApi = apiC;
    rerender();
    await waitFor(() => {
      expect(apiC.onK6Error).toHaveBeenCalledOnce();
      expect(result.current.state.error).toBeNull();
    });
  });

  it("cleans every registered listener on unmount", async () => {
    const unlistenOutput = vi.fn();
    const unlistenMetrics = vi.fn();
    const unlistenComplete = vi.fn();
    const unlistenError = vi.fn();
    const { api } = createApiMock({
      onK6Output: vi.fn(async () => unlistenOutput),
      onK6Metrics: vi.fn(async () => unlistenMetrics),
      onK6Complete: vi.fn(async () => unlistenComplete),
      onK6Error: vi.fn(async () => unlistenError),
    });
    const { unmount } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(api.onK6Error).toHaveBeenCalledOnce();
    });
    unmount();

    expect(unlistenOutput).toHaveBeenCalledOnce();
    expect(unlistenMetrics).toHaveBeenCalledOnce();
    expect(unlistenComplete).toHaveBeenCalledOnce();
    expect(unlistenError).toHaveBeenCalledOnce();
  });

  it("replaces API listeners without leaving callbacks from the previous API", async () => {
    const oldUnlisteners = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const { api: oldApi } = createApiMock({
      onK6Output: vi.fn(async () => oldUnlisteners[0]!),
      onK6Metrics: vi.fn(async () => oldUnlisteners[1]!),
      onK6Complete: vi.fn(async () => oldUnlisteners[2]!),
      onK6Error: vi.fn(async () => oldUnlisteners[3]!),
    });
    const { api: newApi } = createApiMock();
    let currentApi = oldApi;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
      );
    }
    const { rerender } = renderHook(() => useTestHarness(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(oldApi.onK6Error).toHaveBeenCalledOnce();
    });
    currentApi = newApi;
    rerender();

    await waitFor(() => {
      expect(newApi.onK6Error).toHaveBeenCalledOnce();
    });
    for (const unlisten of oldUnlisteners) {
      expect(unlisten).toHaveBeenCalledOnce();
    }
  });

  it("clears a pending refresh and ignores its response after API replacement", async () => {
    const oldStatus = deferred<GetTestStatusResponse>();
    const { api: oldApi } = createApiMock({
      getTestStatus: vi.fn(() => oldStatus.promise),
    });
    const { api: newApi } = createApiMock({
      getTestStatus: vi.fn<LoadRiftApi["getTestStatus"]>().mockResolvedValue({
        runId: null,
        status: "idle",
        isRunning: false,
        metrics: null,
        result: null,
        finishReason: null,
        errorMessage: null,
        resultSource: null,
        summaryIssue: null,
      }),
    });
    let currentApi = oldApi;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
      );
    }
    const { result, rerender } = renderHook(() => useTestHarness(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(oldApi.onK6Error).toHaveBeenCalledOnce();
    });
    let refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = result.current.refreshStatus();
      await Promise.resolve();
    });
    expect(result.current.state.isBusy).toBe(true);

    currentApi = newApi;
    rerender();
    await waitFor(() => {
      expect(newApi.onK6Error).toHaveBeenCalledOnce();
      expect(result.current.state.isBusy).toBe(false);
    });

    await act(async () => {
      oldStatus.resolve(runningStatus("old-api-run"));
      await refreshPromise;
    });
    expect(result.current.state.status).toBe("idle");
    expect(result.current.state.runId).toBeNull();
    expect(result.current.state.isBusy).toBe(false);
  });

  it("hydrates the current provider when the same API object returns during an old refresh", async () => {
    const originalStatus = deferred<GetTestStatusResponse>();
    const apiAStatus = vi
      .fn<LoadRiftApi["getTestStatus"]>()
      .mockReturnValueOnce(originalStatus.promise)
      .mockResolvedValueOnce(runningStatus("current-api-a-run"));
    const { api: apiA } = createApiMock({ getTestStatus: apiAStatus });
    const apiBStatus = vi
      .fn<LoadRiftApi["getTestStatus"]>()
      .mockResolvedValue(idleStatus());
    const { api: apiB } = createApiMock({ getTestStatus: apiBStatus });
    let currentApi = apiA;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
      );
    }
    const { result, rerender } = renderHook(() => useTestHarness(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(apiA.onK6Error).toHaveBeenCalledOnce();
    });
    let originalRefreshPromise!: Promise<void>;
    await act(async () => {
      originalRefreshPromise = result.current.refreshStatus();
      await Promise.resolve();
    });

    currentApi = apiB;
    rerender();
    await waitFor(() => {
      expect(apiBStatus).toHaveBeenCalledOnce();
      expect(result.current.state.status).toBe("idle");
    });

    currentApi = apiA;
    rerender();
    await waitFor(() => {
      expect(apiAStatus).toHaveBeenCalledTimes(2);
      expect(result.current.state.runId).toBe("current-api-a-run");
    });

    await act(async () => {
      originalStatus.resolve({
        ...runningStatus("stale-api-a-run"),
        status: "completed",
        isRunning: false,
      });
      await originalRefreshPromise;
    });

    expect(result.current.state.status).toBe("running");
    expect(result.current.state.runId).toBe("current-api-a-run");
    expect(result.current.state.isRunning).toBe(true);
    expect(result.current.state.isBusy).toBe(false);
  });

  it("allows a replacement API stop after status hydration rejects", async () => {
    const oldStopRequest = deferred<void>();
    const { api: oldApi } = createApiMock({
      stopTest: vi.fn(() => oldStopRequest.promise),
    });
    const replacementStatus = vi
      .fn<LoadRiftApi["getTestStatus"]>()
      .mockRejectedValue(new Error("replacement status unavailable"));
    const replacementStop = vi.fn<LoadRiftApi["stopTest"]>();
    const { api: newApi } = createApiMock({
      getTestStatus: replacementStatus,
      stopTest: replacementStop,
    });
    let currentApi = oldApi;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
      );
    }
    const { result, rerender } = renderHook(() => useTestHarness(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(oldApi.onK6Error).toHaveBeenCalledOnce();
    });
    await act(async () => {
      await result.current.startTest(startOptions);
    });
    let oldStopPromise!: Promise<void>;
    await act(async () => {
      oldStopPromise = result.current.stopTest();
      await Promise.resolve();
    });

    currentApi = newApi;
    rerender();
    await waitFor(() => {
      expect(result.current.state.error).toBe("replacement status unavailable");
    });
    expect(result.current.state.isRunning).toBe(true);
    expect(result.current.state.isBusy).toBe(false);

    await act(async () => {
      await result.current.stopTest();
    });

    expect(replacementStop).toHaveBeenCalledOnce();
    expect(result.current.state.status).toBe("stopped");
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.isRunning).toBe(false);

    await act(async () => {
      oldStopRequest.resolve();
      await oldStopPromise;
    });

    expect(replacementStatus).toHaveBeenCalledOnce();
    expect(result.current.state.status).toBe("stopped");
    expect(result.current.state.isRunning).toBe(false);
  });

  it("reconciles a pending start after the same API object returns", async () => {
    const startRequest = deferred<StartTestResponse>();
    const apiAStatus = vi
      .fn<LoadRiftApi["getTestStatus"]>()
      .mockResolvedValueOnce(idleStatus())
      .mockResolvedValueOnce(runningStatus("api-a-run"));
    const { api: apiA } = createApiMock({
      startTest: vi.fn(() => startRequest.promise),
      getTestStatus: apiAStatus,
    });
    const apiBStatus = vi.fn<LoadRiftApi["getTestStatus"]>().mockResolvedValue({
      runId: null,
      status: "idle",
      isRunning: false,
      metrics: null,
      result: null,
      finishReason: null,
      errorMessage: null,
      resultSource: null,
      summaryIssue: null,
    });
    const { api: apiB } = createApiMock({ getTestStatus: apiBStatus });
    let currentApi = apiA;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
      );
    }
    const { result, rerender } = renderHook(() => useTestHarness(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(apiA.onK6Error).toHaveBeenCalledOnce();
    });
    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = result.current.startTest(startOptions);
      await Promise.resolve();
    });

    currentApi = apiB;
    rerender();
    await waitFor(() => {
      expect(apiBStatus).toHaveBeenCalledOnce();
      expect(result.current.state.status).toBe("idle");
    });

    currentApi = apiA;
    rerender();
    await waitFor(() => {
      expect(apiA.onK6Error).toHaveBeenCalledTimes(2);
      expect(apiAStatus).toHaveBeenCalledOnce();
      expect(result.current.state.status).toBe("idle");
    });

    await act(async () => {
      startRequest.resolve({ runId: "api-a-run" });
      await startPromise;
    });

    expect(apiAStatus).toHaveBeenCalledTimes(2);
    expect(result.current.state.status).toBe("running");
    expect(result.current.state.runId).toBe("api-a-run");
    expect(result.current.state.isRunning).toBe(true);
    expect(result.current.state.isBusy).toBe(false);
  });

  it("reconciles a pending stop after the same API object returns", async () => {
    const stopRequest = deferred<void>();
    let runId = "missing-run";
    const apiAStatus = vi
      .fn<LoadRiftApi["getTestStatus"]>()
      .mockImplementationOnce(async () => runningStatus(runId))
      .mockImplementationOnce(async () => ({
        ...runningStatus(runId),
        status: "stopped",
        isRunning: false,
        finishReason: "stopped",
      }));
    const { api: apiA } = createApiMock({
      stopTest: vi.fn(() => stopRequest.promise),
      getTestStatus: apiAStatus,
    });
    const apiBStatus = vi
      .fn<LoadRiftApi["getTestStatus"]>()
      .mockImplementation(async () => runningStatus(runId));
    const { api: apiB } = createApiMock({ getTestStatus: apiBStatus });
    let currentApi = apiA;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
      );
    }
    const { result, rerender } = renderHook(() => useTestHarness(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(apiA.onK6Error).toHaveBeenCalledOnce();
    });
    await act(async () => {
      await result.current.startTest(startOptions);
    });
    runId = result.current.state.runId ?? "missing-run";
    let stopPromise!: Promise<void>;
    await act(async () => {
      stopPromise = result.current.stopTest();
      await Promise.resolve();
    });

    currentApi = apiB;
    rerender();
    await waitFor(() => {
      expect(apiBStatus).toHaveBeenCalledOnce();
      expect(result.current.state.status).toBe("running");
    });

    currentApi = apiA;
    rerender();
    await waitFor(() => {
      expect(apiA.onK6Error).toHaveBeenCalledTimes(2);
      expect(apiAStatus).toHaveBeenCalledOnce();
      expect(result.current.state.status).toBe("running");
    });

    await act(async () => {
      stopRequest.resolve();
      await stopPromise;
    });

    expect(apiAStatus).toHaveBeenCalledTimes(2);
    expect(result.current.state.status).toBe("stopped");
    expect(result.current.state.runId).toBe(runId);
    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.isBusy).toBe(false);
  });

  it("does not reconcile a detached start after the replacement API completes", async () => {
    const startRequest = deferred<StartTestResponse>();
    const { api: apiA } = createApiMock({
      startTest: vi.fn(() => startRequest.promise),
    });
    const apiBStatus = vi
      .fn<LoadRiftApi["getTestStatus"]>()
      .mockResolvedValue(runningStatus("api-b-run"));
    const { api: apiB, listeners: apiBListeners } = createApiMock({
      getTestStatus: apiBStatus,
    });
    let currentApi = apiA;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
      );
    }
    const { result, rerender } = renderHook(() => useTestHarness(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(apiA.onK6Error).toHaveBeenCalledOnce();
    });
    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = result.current.startTest(startOptions);
      await Promise.resolve();
    });

    currentApi = apiB;
    rerender();
    await waitFor(() => {
      expect(apiBStatus).toHaveBeenCalledOnce();
      expect(apiBListeners.complete).toBeTypeOf("function");
      expect(result.current.state.runId).toBe("api-b-run");
    });

    act(() => {
      apiBListeners.complete?.(completionPayload("api-b-run"));
    });
    await act(async () => {
      startRequest.resolve({ runId: "api-a-run" });
      await startPromise;
    });

    expect(apiBStatus).toHaveBeenCalledOnce();
    expect(result.current.state.status).toBe("completed");
    expect(result.current.state.runId).toBe("api-b-run");
    expect(result.current.state.result).toEqual(resultPayload);
    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.isBusy).toBe(false);
  });

  it("does not reconcile a detached stop after the replacement API fails", async () => {
    const stopRequest = deferred<void>();
    const { api: apiA } = createApiMock({
      stopTest: vi.fn(() => stopRequest.promise),
    });
    let runId = "missing-run";
    const apiBStatus = vi
      .fn<LoadRiftApi["getTestStatus"]>()
      .mockImplementation(async () => runningStatus(runId));
    const { api: apiB, listeners: apiBListeners } = createApiMock({
      getTestStatus: apiBStatus,
    });
    let currentApi = apiA;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
      );
    }
    const { result, rerender } = renderHook(() => useTestHarness(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(apiA.onK6Error).toHaveBeenCalledOnce();
    });
    await act(async () => {
      await result.current.startTest(startOptions);
    });
    runId = result.current.state.runId ?? "missing-run";
    let stopPromise!: Promise<void>;
    await act(async () => {
      stopPromise = result.current.stopTest();
      await Promise.resolve();
    });

    currentApi = apiB;
    rerender();
    await waitFor(() => {
      expect(apiBStatus).toHaveBeenCalledOnce();
      expect(apiBListeners.error).toBeTypeOf("function");
      expect(result.current.state.status).toBe("running");
    });

    act(() => {
      apiBListeners.error?.({ runId, message: "replacement runner failed" });
    });
    await act(async () => {
      stopRequest.resolve();
      await stopPromise;
    });

    expect(apiBStatus).toHaveBeenCalledOnce();
    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.finishReason).toBe("execution_error");
    expect(result.current.state.error).toBe("replacement runner failed");
    expect(result.current.state.runId).toBe(runId);
    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.isBusy).toBe(false);
  });

  it("reconciles with the replacement API after a pending start settles", async () => {
    const startRequest = deferred<StartTestResponse>();
    const initialReplacementStatus = deferred<GetTestStatusResponse>();
    const { api: oldApi } = createApiMock({
      startTest: vi.fn(() => startRequest.promise),
    });
    const replacementStatus = vi
      .fn<LoadRiftApi["getTestStatus"]>()
      .mockReturnValueOnce(initialReplacementStatus.promise)
      .mockResolvedValueOnce(runningStatus("backend-run"));
    const { api: newApi } = createApiMock({
      getTestStatus: replacementStatus,
    });
    let currentApi = oldApi;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
      );
    }
    const { result, rerender } = renderHook(() => useTestHarness(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(oldApi.onK6Error).toHaveBeenCalledOnce();
    });
    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = result.current.startTest(startOptions);
      await Promise.resolve();
    });

    currentApi = newApi;
    rerender();
    await waitFor(() => {
      expect(replacementStatus).toHaveBeenCalledOnce();
    });
    await act(async () => {
      initialReplacementStatus.resolve({
        runId: null,
        status: "idle",
        isRunning: false,
        metrics: null,
        result: null,
        finishReason: null,
        errorMessage: null,
        resultSource: null,
        summaryIssue: null,
      });
      await initialReplacementStatus.promise;
    });
    expect(result.current.state.status).toBe("idle");

    await act(async () => {
      startRequest.resolve({ runId: "backend-run" });
      await startPromise;
    });

    expect(replacementStatus).toHaveBeenCalledTimes(2);
    expect(result.current.state.status).toBe("running");
    expect(result.current.state.runId).toBe("backend-run");
    expect(result.current.state.isRunning).toBe(true);
    expect(result.current.state.isBusy).toBe(false);
  });

  it("reconciles with the replacement API after a pending stop settles", async () => {
    const stopRequest = deferred<void>();
    const initialReplacementStatus = deferred<GetTestStatusResponse>();
    const { api: oldApi } = createApiMock({
      stopTest: vi.fn(() => stopRequest.promise),
    });
    let runId = "missing-run";
    const replacementStatus = vi
      .fn<LoadRiftApi["getTestStatus"]>()
      .mockReturnValueOnce(initialReplacementStatus.promise)
      .mockImplementationOnce(async () => ({
        ...runningStatus(runId),
        status: "stopped",
        isRunning: false,
        finishReason: "stopped",
      }));
    const { api: newApi } = createApiMock({
      getTestStatus: replacementStatus,
    });
    let currentApi = oldApi;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
      );
    }
    const { result, rerender } = renderHook(() => useTestHarness(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(oldApi.onK6Error).toHaveBeenCalledOnce();
    });
    await act(async () => {
      await result.current.startTest(startOptions);
    });
    runId = result.current.state.runId ?? "missing-run";
    let stopPromise!: Promise<void>;
    await act(async () => {
      stopPromise = result.current.stopTest();
      await Promise.resolve();
    });

    currentApi = newApi;
    rerender();
    await waitFor(() => {
      expect(replacementStatus).toHaveBeenCalledOnce();
    });
    await act(async () => {
      initialReplacementStatus.resolve(runningStatus(runId));
      await initialReplacementStatus.promise;
    });
    expect(result.current.state.status).toBe("running");

    await act(async () => {
      stopRequest.resolve();
      await stopPromise;
    });

    expect(replacementStatus).toHaveBeenCalledTimes(2);
    expect(result.current.state.status).toBe("stopped");
    expect(result.current.state.runId).toBe(runId);
    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.isBusy).toBe(false);
  });

  it("does not let an old pending start reconciliation supersede a replacement API start", async () => {
    const oldStartRequest = deferred<StartTestResponse>();
    const replacementStartRequest = deferred<StartTestResponse>();
    const initialReplacementStatus = deferred<GetTestStatusResponse>();
    const { api: oldApi } = createApiMock({
      startTest: vi.fn(() => oldStartRequest.promise),
    });
    const replacementStatus = vi
      .fn<LoadRiftApi["getTestStatus"]>()
      .mockReturnValueOnce(initialReplacementStatus.promise)
      .mockResolvedValue({
        runId: null,
        status: "idle",
        isRunning: false,
        metrics: null,
        result: null,
        finishReason: null,
        errorMessage: null,
        resultSource: null,
        summaryIssue: null,
      });
    const { api: newApi } = createApiMock({
      startTest: vi.fn(() => replacementStartRequest.promise),
      getTestStatus: replacementStatus,
    });
    let currentApi = oldApi;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
      );
    }
    const { result, rerender } = renderHook(() => useTestHarness(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(oldApi.onK6Error).toHaveBeenCalledOnce();
    });
    let oldStartPromise!: Promise<void>;
    await act(async () => {
      oldStartPromise = result.current.startTest(startOptions);
      await Promise.resolve();
    });

    currentApi = newApi;
    rerender();
    await waitFor(() => {
      expect(replacementStatus).toHaveBeenCalledOnce();
    });

    let replacementStartPromise!: Promise<void>;
    await act(async () => {
      replacementStartPromise = result.current.startTest(startOptions);
      await Promise.resolve();
    });
    const replacementRunId = vi.mocked(newApi.startTest).mock.calls[0]![0]
      .runId;
    await act(async () => {
      oldStartRequest.resolve({ runId: "old-run" });
      await oldStartPromise;
    });
    expect(replacementStatus).toHaveBeenCalledOnce();

    await act(async () => {
      initialReplacementStatus.resolve({
        runId: null,
        status: "idle",
        isRunning: false,
        metrics: null,
        result: null,
        finishReason: null,
        errorMessage: null,
        resultSource: null,
        summaryIssue: null,
      });
      await initialReplacementStatus.promise;
      replacementStartRequest.resolve({ runId: "replacement-run" });
      await replacementStartPromise;
    });

    expect(result.current.state.status).toBe("running");
    expect(result.current.state.runId).toBe(replacementRunId);
    expect(result.current.state.isRunning).toBe(true);
    expect(result.current.state.isBusy).toBe(false);
  });

  it("does not let an old pending stop reconciliation supersede a replacement API start", async () => {
    const oldStopRequest = deferred<void>();
    const replacementStartRequest = deferred<StartTestResponse>();
    const initialReplacementStatus = deferred<GetTestStatusResponse>();
    const { api: oldApi } = createApiMock({
      stopTest: vi.fn(() => oldStopRequest.promise),
    });
    const replacementStatus = vi
      .fn<LoadRiftApi["getTestStatus"]>()
      .mockReturnValueOnce(initialReplacementStatus.promise)
      .mockResolvedValue({
        runId: null,
        status: "idle",
        isRunning: false,
        metrics: null,
        result: null,
        finishReason: null,
        errorMessage: null,
        resultSource: null,
        summaryIssue: null,
      });
    const { api: newApi } = createApiMock({
      startTest: vi.fn(() => replacementStartRequest.promise),
      getTestStatus: replacementStatus,
    });
    let currentApi = oldApi;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <LoadRiftApiProvider api={currentApi}>{children}</LoadRiftApiProvider>
      );
    }
    const { result, rerender } = renderHook(() => useTestHarness(), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(oldApi.onK6Error).toHaveBeenCalledOnce();
    });
    await act(async () => {
      await result.current.startTest(startOptions);
    });
    let oldStopPromise!: Promise<void>;
    await act(async () => {
      oldStopPromise = result.current.stopTest();
      await Promise.resolve();
    });

    currentApi = newApi;
    rerender();
    await waitFor(() => {
      expect(replacementStatus).toHaveBeenCalledOnce();
    });

    let replacementStartPromise!: Promise<void>;
    await act(async () => {
      replacementStartPromise = result.current.startTest(startOptions);
      await Promise.resolve();
    });
    const replacementRunId = vi.mocked(newApi.startTest).mock.calls[0]![0]
      .runId;
    await act(async () => {
      oldStopRequest.resolve();
      await oldStopPromise;
    });
    expect(replacementStatus).toHaveBeenCalledOnce();

    await act(async () => {
      initialReplacementStatus.resolve({
        runId: null,
        status: "idle",
        isRunning: false,
        metrics: null,
        result: null,
        finishReason: null,
        errorMessage: null,
        resultSource: null,
        summaryIssue: null,
      });
      await initialReplacementStatus.promise;
      replacementStartRequest.resolve({ runId: "replacement-run" });
      await replacementStartPromise;
    });

    expect(result.current.state.status).toBe("running");
    expect(result.current.state.runId).toBe(replacementRunId);
    expect(result.current.state.isRunning).toBe(true);
    expect(result.current.state.isBusy).toBe(false);
  });

  it("applies listener updates for output, current-run metrics, completion, and errors", async () => {
    const { api, listeners } = createApiMock();
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(listeners.output).toBeTypeOf("function");
      expect(listeners.metrics).toBeTypeOf("function");
      expect(listeners.complete).toBeTypeOf("function");
      expect(listeners.error).toBeTypeOf("function");
    });

    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const runId =
      vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

    act(() => {
      listeners.output?.("line one\n");
      listeners.metrics?.({ runId, metrics });
      listeners.complete?.({
        ...completionPayload(runId),
        finishReason: "thresholds_failed",
        result: { ...resultPayload, status: "failed" },
      });
    });

    expect(result.current.state.output).toBe("line one\n");
    expect(result.current.state.metrics).toEqual(metrics);
    expect(result.current.state.result).toEqual({
      ...resultPayload,
      status: "failed",
    });
    expect(result.current.state.finishReason).toBe("thresholds_failed");
    expect(result.current.state.resultSource).toBe("summary");
    expect(result.current.state.summaryIssue).toBeNull();
    expect(result.current.state.status).toBe("completed");
    expect(result.current.state.runId).toBe(runId);

    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const nextRunId =
      vi.mocked(api.startTest).mock.calls[1]![0].runId ?? "missing-run";

    act(() => {
      listeners.error?.({ runId: nextRunId, message: "runner crashed" });
    });

    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.finishReason).toBe("execution_error");
    expect(result.current.state.error).toBe("runner crashed");
    expect(result.current.state.runId).toBe(nextRunId);
  });

  it("clears retained state and ignores stale run events after clearing", async () => {
    const { api, listeners } = createApiMock();
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(listeners.output).toBeTypeOf("function");
      expect(listeners.metrics).toBeTypeOf("function");
      expect(listeners.complete).toBeTypeOf("function");
      expect(listeners.error).toBeTypeOf("function");
    });

    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const runId =
      vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

    act(() => {
      listeners.output?.("previous output\n");
      listeners.metrics?.({ runId, metrics });
      listeners.complete?.(completionPayload(runId));
    });

    expect(result.current.state.output).toBe("previous output\n");
    expect(result.current.state.result).toEqual(resultPayload);

    act(() => {
      result.current.clearTestState();
    });

    expect(result.current.state).toMatchObject({
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
    });

    act(() => {
      listeners.output?.("late output\n");
      listeners.metrics?.({ runId, metrics });
      listeners.complete?.({
        ...completionPayload(runId),
        finishReason: "late-complete",
      });
      listeners.error?.({ runId, message: "late error" });
    });

    expect(result.current.state).toMatchObject({
      status: "idle",
      metrics: DEFAULT_LIVE_METRICS,
      result: null,
      finishReason: null,
      error: null,
      runId: null,
      output: "",
    });
  });

  it("preserves a completion event that arrives before startTest resolves", async () => {
    const startRequest = deferred<StartTestResponse>();
    let capturedRunId = "";
    const { api, listeners } = createApiMock({
      startTest: vi.fn((input: { options: K6Options; runId?: string }) => {
        capturedRunId = input.runId ?? "missing-run";
        return startRequest.promise;
      }),
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(listeners.complete).toBeTypeOf("function");
    });

    await act(async () => {
      void result.current.startTest(startOptions);
      await Promise.resolve();
    });

    act(() => {
      listeners.complete?.(completionPayload(capturedRunId));
    });

    await act(async () => {
      startRequest.resolve({ runId: capturedRunId });
      await startRequest.promise;
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("completed");
    expect(result.current.state.finishReason).toBe("completed");
    expect(result.current.state.runId).toBe(capturedRunId);
    expect(result.current.state.isRunning).toBe(false);
  });

  it("keeps a completion event when it arrives before a pending stop succeeds", async () => {
    const stopRequest = deferred<void>();
    const { api, listeners } = createApiMock({
      stopTest: vi.fn(() => stopRequest.promise),
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(listeners.complete).toBeTypeOf("function");
    });
    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const runId = result.current.state.runId ?? "missing-run";
    let stopPromise!: Promise<void>;
    await act(async () => {
      stopPromise = result.current.stopTest();
      await Promise.resolve();
    });

    act(() => {
      listeners.complete?.(completionPayload(runId));
    });
    await act(async () => {
      stopRequest.resolve();
      await stopPromise;
    });

    expect(result.current.state.status).toBe("completed");
    expect(result.current.state.finishReason).toBe("completed");
    expect(result.current.state.result).toEqual(resultPayload);
    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.isBusy).toBe(false);
  });

  it("keeps a terminal error event when it arrives before a pending stop rejects", async () => {
    const stopRequest = deferred<void>();
    const { api, listeners } = createApiMock({
      stopTest: vi.fn(() => stopRequest.promise),
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(listeners.error).toBeTypeOf("function");
    });
    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const runId = result.current.state.runId ?? "missing-run";
    let stopPromise!: Promise<void>;
    await act(async () => {
      stopPromise = result.current.stopTest();
      await Promise.resolve();
    });

    act(() => {
      listeners.error?.({ runId, message: "runner exited while stopping" });
    });
    await act(async () => {
      stopRequest.reject(new Error("late stop rejection"));
      await stopPromise;
    });

    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.finishReason).toBe("execution_error");
    expect(result.current.state.error).toBe("runner exited while stopping");
    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.isBusy).toBe(false);
  });

  it("keeps the primary completion error when a same-run error follows failed completion", async () => {
    const { api, listeners } = createApiMock();
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(listeners.complete).toBeTypeOf("function");
      expect(listeners.error).toBeTypeOf("function");
    });

    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const runId =
      vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

    act(() => {
      listeners.complete?.({
        ...completionPayload(runId),
        runState: "failed",
        finishReason: "execution_error",
        result: { ...resultPayload, status: "failed" },
        errorMessage:
          'The moduleSpecifier "/tmp/loadrift/run/script.js" couldn\'t be found on local disk.',
      });
      listeners.error?.({
        runId,
        message: "k6 exited with a non-zero status",
      });
    });

    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.finishReason).toBe("execution_error");
    expect(result.current.state.error).toBe(
      'The moduleSpecifier "/tmp/loadrift/run/script.js" couldn\'t be found on local disk.',
    );
    expect(result.current.state.runId).toBe(runId);
  });

  it("preserves primary k6 error and fallback context from completion", async () => {
    const primaryError =
      'The moduleSpecifier "/tmp/loadrift/run/script.js" couldn\'t be found on local disk.';
    const summaryIssue = "summary.json was not written before k6 exited";
    const { api, listeners } = createApiMock();
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(listeners.complete).toBeTypeOf("function");
    });

    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const runId =
      vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

    act(() => {
      listeners.complete?.({
        ...completionPayload(runId),
        runState: "failed",
        finishReason: "execution_error",
        result: { ...resultPayload, status: "failed" },
        resultSource: "liveMetricsFallback",
        summaryIssue,
        errorMessage: primaryError,
      });
    });

    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.finishReason).toBe("execution_error");
    expect(result.current.state.resultSource).toBe("liveMetricsFallback");
    expect(result.current.state.summaryIssue).toBe(summaryIssue);
    expect(result.current.state.error).toBe(primaryError);
  });

  it("keeps fallback context when a same-run error event follows completion", async () => {
    const summaryIssue = "summary parsing failed";
    const { api, listeners } = createApiMock();
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(listeners.complete).toBeTypeOf("function");
      expect(listeners.error).toBeTypeOf("function");
    });

    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const runId =
      vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

    act(() => {
      listeners.complete?.({
        ...completionPayload(runId),
        runState: "failed",
        finishReason: "execution_error",
        result: { ...resultPayload, status: "failed" },
        resultSource: "liveMetricsFallback",
        summaryIssue,
        errorMessage: "primary stderr",
      });
      listeners.error?.({ runId, message: "primary stderr from k6:error" });
    });

    expect(result.current.state.error).toBe("primary stderr");
    expect(result.current.state.resultSource).toBe("liveMetricsFallback");
    expect(result.current.state.summaryIssue).toBe(summaryIssue);
  });

  it("ignores stale metrics, completion, and error events for older runs", async () => {
    const { api, listeners } = createApiMock();
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(listeners.metrics).toBeTypeOf("function");
      expect(listeners.complete).toBeTypeOf("function");
      expect(listeners.error).toBeTypeOf("function");
    });

    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const activeRunId =
      vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

    act(() => {
      listeners.metrics?.({ runId: "old-run", metrics });
      listeners.complete?.({
        ...completionPayload("old-run"),
        finishReason: "old-complete",
      });
      listeners.error?.({ runId: "old-run", message: "old crash" });
    });

    expect(result.current.state.status).toBe("running");
    expect(result.current.state.metrics.totalRequests).toBe(0);
    expect(result.current.state.result).toBeNull();
    expect(result.current.state.finishReason).toBeNull();
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.resultSource).toBeNull();
    expect(result.current.state.summaryIssue).toBeNull();
    expect(result.current.state.runId).toBe(activeRunId);

    act(() => {
      listeners.metrics?.({ runId: activeRunId, metrics });
    });

    expect(result.current.state.metrics).toEqual(metrics);
  });

  it("rejects malformed status payloads from the API boundary", async () => {
    const { api } = createApiMock({
      getTestStatus: vi.fn(
        async () =>
          ({
            runId: 42,
            status: "surprising",
            isRunning: true,
            metrics: {
              activeVus: Number.NaN,
              totalRequests: 12,
              failedRequests: "nope",
              errorRate: 0.25,
            },
            result: {
              status: "unexpected",
              metrics: {
                totalRequests: 12,
                failedRequests: 3,
              },
              thresholds: [
                {
                  name: "http_req_failed",
                  passed: true,
                  actual: "bad",
                  threshold: 1,
                },
                null,
              ],
            },
            finishReason: 17,
            errorMessage: null,
            resultSource: "not-a-source",
            summaryIssue: false,
          }) as unknown as Promise<GetTestStatusResponse>,
      ),
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      await result.current.refreshStatus();
    });

    expect(result.current.state.runId).toBeNull();
    expect(result.current.state.status).toBe("idle");
    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.metrics).toEqual(DEFAULT_LIVE_METRICS);
    expect(result.current.state.result).toBeNull();
    expect(result.current.state.finishReason).toBeNull();
    expect(result.current.state.resultSource).toBeNull();
    expect(result.current.state.summaryIssue).toBeNull();
    expect(result.current.state.error).toBe(
      "Invalid test status response from the native runtime.",
    );
  });

  it("ignores malformed run events and defaults malformed current-run metrics", async () => {
    const { api, listeners } = createApiMock();
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(listeners.metrics).toBeTypeOf("function");
      expect(listeners.complete).toBeTypeOf("function");
      expect(listeners.error).toBeTypeOf("function");
    });

    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const runId =
      vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

    act(() => {
      listeners.metrics?.({ metrics } as unknown as RunMetricsEvent);
      listeners.error?.({
        message: "missing run id",
      } as unknown as RunErrorEvent);
      listeners.complete?.({
        runState: "completed",
      } as unknown as TestCompletion);
    });

    expect(result.current.state.status).toBe("running");
    expect(result.current.state.metrics).toEqual(DEFAULT_LIVE_METRICS);
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.result).toBeNull();

    act(() => {
      listeners.metrics?.({
        runId,
        metrics: {
          activeVus: 5,
          totalRequests: "many",
          failedRequests: 2,
          errorRate: Number.POSITIVE_INFINITY,
        },
      } as unknown as RunMetricsEvent);
    });

    expect(result.current.state.metrics).toEqual({
      activeVus: 5,
      totalRequests: 0,
      failedRequests: 2,
      errorRate: 0,
      avgResponseTime: 0,
      p50ResponseTime: 0,
      p95ResponseTime: 0,
      maxResponseTime: 0,
      requestsPerSecond: 0,
    });
  });

  it("falls back to the generated run id when startTest returns a malformed response", async () => {
    const { api } = createApiMock({
      startTest: vi.fn(
        async () => ({}) as unknown as Promise<StartTestResponse>,
      ),
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      await result.current.startTest(startOptions);
    });

    const generatedRunId = vi.mocked(api.startTest).mock.calls[0]![0].runId;
    expect(result.current.state.runId).toBe(generatedRunId);
    expect(result.current.state.status).toBe("running");
    expect(result.current.state.isRunning).toBe(true);
  });

  it("ignores non-terminal completion events", async () => {
    const { api, listeners } = createApiMock();
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await waitFor(() => {
      expect(listeners.complete).toBeTypeOf("function");
    });

    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const runId =
      vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

    act(() => {
      listeners.complete?.({
        ...completionPayload(runId),
        runState: "running" as TestCompletion["runState"],
      });
    });

    expect(result.current.state.status).toBe("running");
    expect(result.current.state.isRunning).toBe(true);
    expect(result.current.state.runId).toBe(runId);
  });

  it("surfaces start failures with a normalized error message", async () => {
    const { api } = createApiMock({
      startTest: vi.fn(async () => {
        throw new Error("No k6 binary found");
      }),
    });
    const { result } = renderHook(() => useTestHarness(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      await result.current.startTest(startOptions);
    });

    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.error).toBe("No k6 binary found");
    expect(result.current.state.isBusy).toBe(false);
    expect(result.current.state.isRunning).toBe(false);
  });
});
