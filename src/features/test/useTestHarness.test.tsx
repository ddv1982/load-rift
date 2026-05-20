import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LoadRiftApi } from "../../lib/loadrift/api";
import type {
  GetTestStatusResponse,
  K6Options,
  LiveMetrics,
  RunErrorEvent,
  RunMetricsEvent,
  StartTestResponse,
  TestCompletion,
  TestResult,
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
    importCollectionFromFile: vi.fn(),
    validateTestConfiguration: vi.fn(),
    smokeTestRequests: vi.fn(),
    startTest: vi.fn(async (input: { options: K6Options; runId?: string }) => ({
      runId: input.runId ?? "test-run",
    })),
    stopTest: vi.fn(),
    exportReport: vi.fn(),
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
    const runId = vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

    act(() => {
      listeners.output?.("line one\n");
      listeners.metrics?.({ runId, metrics });
      listeners.complete?.({
        ...completionPayload(runId),
        finishReason: "thresholds_failed",
      });
    });

    expect(result.current.state.output).toBe("line one\n");
    expect(result.current.state.metrics).toEqual(metrics);
    expect(result.current.state.result).toEqual(resultPayload);
    expect(result.current.state.finishReason).toBe("thresholds_failed");
    expect(result.current.state.resultSource).toBe("summary");
    expect(result.current.state.summaryIssue).toBeNull();
    expect(result.current.state.status).toBe("completed");
    expect(result.current.state.runId).toBe(runId);

    await act(async () => {
      await result.current.startTest(startOptions);
    });
    const nextRunId = vi.mocked(api.startTest).mock.calls[1]![0].runId ?? "missing-run";

    act(() => {
      listeners.error?.({ runId: nextRunId, message: "runner crashed" });
    });

    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.finishReason).toBe("execution_error");
    expect(result.current.state.error).toBe("runner crashed");
    expect(result.current.state.runId).toBe(nextRunId);
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
    const runId = vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

    act(() => {
      listeners.complete?.({
        ...completionPayload(runId),
        runState: "failed",
        finishReason: "execution_error",
        errorMessage: "The moduleSpecifier \"/tmp/loadrift/run/script.js\" couldn't be found on local disk.",
      });
      listeners.error?.({
        runId,
        message: "k6 exited with a non-zero status",
      });
    });

    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.finishReason).toBe("execution_error");
    expect(result.current.state.error).toBe(
      "The moduleSpecifier \"/tmp/loadrift/run/script.js\" couldn't be found on local disk.",
    );
    expect(result.current.state.runId).toBe(runId);
  });

  it("preserves primary k6 error and fallback context from completion", async () => {
    const primaryError =
      "The moduleSpecifier \"/tmp/loadrift/run/script.js\" couldn't be found on local disk.";
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
    const runId = vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

    act(() => {
      listeners.complete?.({
        ...completionPayload(runId),
        runState: "failed",
        finishReason: "execution_error",
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
    const runId = vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

    act(() => {
      listeners.complete?.({
        ...completionPayload(runId),
        runState: "failed",
        finishReason: "execution_error",
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
    const activeRunId = vi.mocked(api.startTest).mock.calls[0]![0].runId ?? "missing-run";

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
