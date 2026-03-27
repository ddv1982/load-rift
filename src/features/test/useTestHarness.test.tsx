import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoadRiftApiProvider } from "../../lib/loadrift/context";
import type { LoadRiftApi } from "../../lib/loadrift/api";
import type {
  GetTestStatusResponse,
  LiveMetrics,
  TestCompletion,
  TestResult,
} from "../../lib/loadrift/types";
import { useTestHarness } from "./useTestHarness";

const metrics: LiveMetrics = {
  activeVus: 2,
  totalRequests: 10,
  failedRequests: 1,
  errorRate: 0.1,
  p50ResponseTime: 90,
  p95ResponseTime: 150,
  requestsPerSecond: 5,
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

function createApiMock(overrides: Partial<LoadRiftApi> = {}) {
  const listeners: {
    output: ((payload: string) => void) | undefined;
    metrics: ((payload: LiveMetrics) => void) | undefined;
    complete: ((payload: TestCompletion) => void) | undefined;
    error: ((payload: string) => void) | undefined;
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
    startTest: vi.fn(),
    stopTest: vi.fn(),
    exportReport: vi.fn(),
    getTestStatus: vi.fn(),
    onK6Output: vi.fn(async (callback: (payload: string) => void) => {
      listeners.output = callback;
      return () => {
        listeners.output = undefined;
      };
    }),
    onK6Metrics: vi.fn(async (callback: (payload: LiveMetrics) => void) => {
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
    onK6Error: vi.fn(async (callback: (payload: string) => void) => {
      listeners.error = callback;
      return () => {
        listeners.error = undefined;
      };
    }),
    ...overrides,
  };

  return { api, listeners };
}

function createWrapper(api: LoadRiftApi) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <LoadRiftApiProvider api={api}>{children}</LoadRiftApiProvider>;
  };
}

describe("useTestHarness", () => {
  it("hydrates state from refreshStatus", async () => {
    const statusResponse: GetTestStatusResponse = {
      status: "completed",
      isRunning: false,
      metrics,
      result: resultPayload,
      finishReason: "completed",
      errorMessage: null,
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

    expect(result.current.state.status).toBe("completed");
    expect(result.current.state.metrics).toEqual(metrics);
    expect(result.current.state.result).toEqual(resultPayload);
    expect(result.current.state.finishReason).toBe("completed");
    expect(result.current.state.isBusy).toBe(false);
    expect(result.current.state.isRunning).toBe(false);
  });

  it("applies listener updates for output, metrics, completion, and errors", async () => {
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

    act(() => {
      listeners.output?.("line one\n");
      listeners.metrics?.(metrics);
      listeners.complete?.({
        runState: "completed",
        finishReason: "thresholds_failed",
        metrics,
        result: resultPayload,
      });
    });

    expect(result.current.state.output).toBe("line one\n");
    expect(result.current.state.metrics).toEqual(metrics);
    expect(result.current.state.result).toEqual(resultPayload);
    expect(result.current.state.finishReason).toBe("thresholds_failed");
    expect(result.current.state.status).toBe("completed");

    act(() => {
      listeners.error?.("runner crashed");
    });

    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.finishReason).toBe("execution_error");
    expect(result.current.state.error).toBe("runner crashed");
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
      await result.current.startTest({
        vus: 1,
        duration: "1s",
        rampUp: "instant",
        rampUpTime: "1s",
        thresholds: {},
        variableOverrides: {},
        advancedOptionsJson: "",
        selectedRequestIds: ["request-0"],
      });
    });

    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.error).toBe("No k6 binary found");
    expect(result.current.state.isBusy).toBe(false);
    expect(result.current.state.isRunning).toBe(false);
  });
});
