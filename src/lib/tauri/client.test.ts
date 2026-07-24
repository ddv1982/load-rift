import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  K6_COMPLETE_EVENT,
  K6_ERROR_EVENT,
  K6_METRICS_EVENT,
  K6_OUTPUT_EVENT,
} from "../loadrift/api";
import {
  DEFAULT_K6_OPTIONS,
  type RunMetricsEvent,
  type TestCompletion,
} from "../loadrift/types";
import { createTauriLoadRiftApi } from "./client";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: tauriMocks.listen }),
}));

const listeners = new Map<string, (event: { payload: unknown }) => void>();

function emit(event: string, payload: unknown) {
  listeners.get(event)?.({ payload });
}

function validCollection() {
  return {
    name: "API collection",
    requestCount: 1,
    folderCount: 1,
    requests: [
      {
        id: "request-1",
        name: "List widgets",
        method: "GET",
        url: "https://example.test/widgets",
        folderPath: ["Widgets"],
      },
    ],
    runtimeVariables: [
      { key: "baseUrl", defaultValue: "https://example.test" },
    ],
  };
}

function validSmokeResponse() {
  return {
    responses: [
      {
        requestId: "request-1",
        requestName: "List widgets",
        method: "GET",
        url: "https://example.test/widgets",
        statusCode: 200,
        durationMs: 12,
        ok: true,
        contentType: "application/json",
        responseHeaders: { "content-type": "application/json" },
        bodyPreview: "[]",
        errorMessage: null,
      },
    ],
  };
}

function validResult() {
  return {
    status: "passed",
    metrics: {
      totalRequests: 4,
      failedRequests: 0,
      avgResponseTime: 12,
      p50ResponseTime: 10,
      p95ResponseTime: 20,
      maxResponseTime: 25,
      requestsPerSecond: 2,
    },
    thresholds: [
      { name: "http_req_failed", passed: true, actual: 0, threshold: 0.01 },
    ],
  };
}

function validCompletion() {
  return {
    runId: "run-1",
    runState: "completed",
    finishReason: "completed",
    metrics: { totalRequests: 4, errorRate: Number.NaN },
    result: validResult(),
    resultSource: "summary",
    summaryIssue: null,
    errorMessage: null,
  };
}

function idleStatus() {
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

beforeEach(() => {
  listeners.clear();
  tauriMocks.invoke.mockReset();
  tauriMocks.listen.mockReset();
  tauriMocks.listen.mockImplementation(
    async (event: string, callback: (event: { payload: unknown }) => void) => {
      listeners.set(event, callback);
      return vi.fn();
    },
  );
});

describe("Tauri command response boundaries", () => {
  it("accepts a valid collection and preserves import cancellation", async () => {
    const api = createTauriLoadRiftApi();
    const collection = {
      ...validCollection(),
      runtimeVariables: [
        { key: "baseUrl", defaultValue: "https://example.test" },
        { key: "token", defaultValue: null },
      ],
    };
    tauriMocks.invoke
      .mockResolvedValueOnce(collection)
      .mockResolvedValueOnce(null);

    await expect(api.selectAndImportCollection()).resolves.toEqual({
      ...collection,
      runtimeVariables: [
        { key: "baseUrl", defaultValue: "https://example.test" },
        { key: "token" },
      ],
    });
    await expect(api.selectAndImportCollection()).resolves.toBeNull();
  });

  it.each([
    ["missing structure", { name: "broken" }],
    ["count mismatch", { ...validCollection(), requestCount: 2 }],
    [
      "blank request identity",
      {
        ...validCollection(),
        requests: [{ ...validCollection().requests[0], id: " " }],
      },
    ],
    [
      "duplicate request identity",
      {
        ...validCollection(),
        requestCount: 2,
        requests: [
          validCollection().requests[0],
          { ...validCollection().requests[0] },
        ],
      },
    ],
  ])("rejects a malformed collection with %s", async (_label, response) => {
    tauriMocks.invoke.mockResolvedValueOnce(response);

    await expect(
      createTauriLoadRiftApi().selectAndImportCollection(),
    ).rejects.toThrow("Invalid collection import response");
  });

  it("validates the validation response ready discriminant", async () => {
    const api = createTauriLoadRiftApi();
    tauriMocks.invoke
      .mockResolvedValueOnce({ ready: false, message: "Select a request." })
      .mockResolvedValueOnce({ ready: "false", message: null });

    await expect(
      api.validateTestConfiguration({ options: DEFAULT_K6_OPTIONS }),
    ).resolves.toEqual({ ready: false, message: "Select a request." });
    await expect(
      api.validateTestConfiguration({ options: DEFAULT_K6_OPTIONS }),
    ).rejects.toThrow("Invalid test validation response");
  });

  it("accepts valid smoke items and rejects a malformed item", async () => {
    const api = createTauriLoadRiftApi();
    const smoke = validSmokeResponse();
    tauriMocks.invoke.mockResolvedValueOnce(smoke).mockResolvedValueOnce({
      responses: [{ ...smoke.responses[0], ok: "yes" }],
    });

    await expect(
      api.smokeTestRequests({ options: DEFAULT_K6_OPTIONS }),
    ).resolves.toEqual(smoke);
    await expect(
      api.smokeTestRequests({ options: DEFAULT_K6_OPTIONS }),
    ).rejects.toThrow("Invalid smoke test response");
  });

  it.each([
    { responses: [] },
    {
      responses: [
        {
          ...validSmokeResponse().responses[0],
          statusCode: null,
          ok: true,
        },
      ],
    },
    {
      responses: [
        { ...validSmokeResponse().responses[0], statusCode: 500, ok: true },
      ],
    },
  ])("rejects an incoherent smoke response %#", async (response) => {
    tauriMocks.invoke.mockResolvedValueOnce(response);

    await expect(
      createTauriLoadRiftApi().smokeTestRequests({
        options: DEFAULT_K6_OPTIONS,
      }),
    ).rejects.toThrow("Invalid smoke test response");
  });

  it("accepts a no-follow redirect smoke response", async () => {
    const response = {
      responses: [
        {
          ...validSmokeResponse().responses[0],
          statusCode: 302,
          responseHeaders: { location: "https://redirect.example.test" },
        },
      ],
    };
    tauriMocks.invoke.mockResolvedValueOnce(response);

    await expect(
      createTauriLoadRiftApi().smokeTestRequests({
        options: DEFAULT_K6_OPTIONS,
      }),
    ).resolves.toEqual(response);
  });

  it("accepts a valid export path, preserves cancellation, and rejects blanks", async () => {
    const api = createTauriLoadRiftApi();
    tauriMocks.invoke
      .mockResolvedValueOnce({ savePath: "/tmp/report.html" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ savePath: "  " });

    await expect(
      api.selectAndExportReport({ defaultPath: "report.html" }),
    ).resolves.toEqual({ savePath: "/tmp/report.html" });
    await expect(
      api.selectAndExportReport({ defaultPath: "report.html" }),
    ).resolves.toBeNull();
    await expect(
      api.selectAndExportReport({ defaultPath: "report.html" }),
    ).rejects.toThrow("Invalid report export response");
  });

  it("accepts coherent status and normalizes non-finite nested metrics", async () => {
    const api = createTauriLoadRiftApi();
    tauriMocks.invoke
      .mockResolvedValueOnce(idleStatus())
      .mockResolvedValueOnce({
        runId: "run-1",
        status: "running",
        isRunning: true,
        metrics: {
          totalRequests: 3,
          requestsPerSecond: Number.POSITIVE_INFINITY,
        },
        result: null,
        finishReason: null,
        errorMessage: null,
        resultSource: null,
        summaryIssue: null,
      })
      .mockResolvedValueOnce({
        runId: "run-1",
        status: "completed",
        isRunning: false,
        metrics: { totalRequests: 3 },
        result: validResult(),
        finishReason: "completed",
        errorMessage: null,
        resultSource: "summary",
        summaryIssue: null,
      });

    await expect(api.getTestStatus()).resolves.toEqual(idleStatus());
    await expect(api.getTestStatus()).resolves.toMatchObject({
      runId: "run-1",
      status: "running",
      isRunning: true,
      metrics: { totalRequests: 3, requestsPerSecond: 0 },
    });
    await expect(api.getTestStatus()).resolves.toMatchObject({
      runId: "run-1",
      status: "completed",
      isRunning: false,
      result: { status: "passed" },
      resultSource: "summary",
    });
  });

  it.each([
    { ...idleStatus(), status: "running" },
    { ...idleStatus(), runId: "run-1" },
    {
      ...idleStatus(),
      runId: "run-1",
      status: "completed",
      isRunning: true,
    },
    {
      ...idleStatus(),
      runId: "run-1",
      status: "failed",
      resultSource: "summary",
    },
    { ...idleStatus(), status: "unknown" },
    {
      ...idleStatus(),
      runId: "run-1",
      status: "completed",
    },
  ])("rejects incoherent status %#", async (response) => {
    tauriMocks.invoke.mockResolvedValueOnce(response);

    await expect(createTauriLoadRiftApi().getTestStatus()).rejects.toThrow(
      "Invalid test status response",
    );
  });

  it.each([undefined, null, {}, { runId: "" }, { runId: "native-run" }])(
    "keeps the caller run ID authoritative for native response %#",
    async (response) => {
      tauriMocks.invoke.mockResolvedValueOnce(response);

      await expect(
        createTauriLoadRiftApi().startTest({
          options: DEFAULT_K6_OPTIONS,
          runId: "caller-run",
        }),
      ).resolves.toEqual({ runId: "caller-run" });
    },
  );

  it("accepts a native run ID only when the caller did not provide one", async () => {
    const api = createTauriLoadRiftApi();
    tauriMocks.invoke
      .mockResolvedValueOnce({ runId: "native-run" })
      .mockResolvedValueOnce({ runId: "" });

    await expect(
      api.startTest({ options: DEFAULT_K6_OPTIONS }),
    ).resolves.toEqual({ runId: "native-run" });
    await expect(
      api.startTest({ options: DEFAULT_K6_OPTIONS }),
    ).rejects.toThrow("Invalid test start response");
  });
});

describe("Tauri event boundaries", () => {
  it("forwards valid output and drops malformed output", async () => {
    const callback = vi.fn();
    await createTauriLoadRiftApi().onK6Output(callback);

    emit(K6_OUTPUT_EVENT, "running\n");
    emit(K6_OUTPUT_EVENT, { line: "not a string" });

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith("running\n");
  });

  it("forwards valid metrics with finite normalization and drops malformed metrics", async () => {
    const callback = vi.fn<(payload: RunMetricsEvent) => void>();
    await createTauriLoadRiftApi().onK6Metrics(callback);

    emit(K6_METRICS_EVENT, {
      runId: "run-1",
      metrics: { totalRequests: 5, errorRate: Number.NaN },
    });
    emit(K6_METRICS_EVENT, { runId: " ", metrics: {} });
    emit(K6_METRICS_EVENT, { runId: "run-1", metrics: null });

    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      runId: "run-1",
      metrics: { totalRequests: 5, errorRate: 0 },
    });
  });

  it("forwards valid terminal completion and drops fabricated lifecycle data", async () => {
    const callback = vi.fn<(payload: TestCompletion) => void>();
    await createTauriLoadRiftApi().onK6Complete(callback);

    emit(K6_COMPLETE_EVENT, validCompletion());
    emit(K6_COMPLETE_EVENT, {
      ...validCompletion(),
      runState: "running",
    });
    emit(K6_COMPLETE_EVENT, {
      ...validCompletion(),
      result: { ...validResult(), status: "unknown" },
    });
    emit(K6_COMPLETE_EVENT, {
      ...validCompletion(),
      finishReason: "execution_error",
      errorMessage: "runner crashed",
    });
    emit(K6_COMPLETE_EVENT, {
      ...validCompletion(),
      errorMessage: "runner crashed",
    });
    emit(K6_COMPLETE_EVENT, { runId: "run-1" });

    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      runId: "run-1",
      runState: "completed",
      metrics: { errorRate: 0 },
    });
  });

  it("requires non-empty error identities and messages", async () => {
    const callback = vi.fn();
    await createTauriLoadRiftApi().onK6Error(callback);

    emit(K6_ERROR_EVENT, { runId: "run-1", message: "k6 failed" });
    emit(K6_ERROR_EVENT, { runId: "", message: "k6 failed" });
    emit(K6_ERROR_EVENT, { runId: "run-1", message: "  " });
    emit(K6_ERROR_EVENT, { runId: "run-1" });

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({
      runId: "run-1",
      message: "k6 failed",
    });
  });
});
