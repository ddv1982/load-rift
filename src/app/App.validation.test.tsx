import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadRiftApi } from "../lib/loadrift/api";
import type { K6Options, SmokeTestResponse, TestResult } from "../lib/loadrift/types";
import {
  appHookTestState,
  resetAppTestEnvironment,
} from "./test-support/appTestState";
import {
  createAppElement,
  createApiMock,
  createImportHookState,
  deferred,
  importedCollection,
  renderApp,
} from "./test-support/appTestUtils";

const DEFAULT_CURL_SNIPPET =
  "curl --location 'https://api.example.com/entities/alpha' --header 'Authorization: Bearer integration-token'";
const BASE_URL_ONLY_CURL_SNIPPET =
  "curl --location 'https://api.example.com/entities/alpha'";
const CHANGED_BASE_URL_CURL_SNIPPET =
  "curl --location 'https://api.changed.example.com/entities/alpha'";
const TOKEN_ONLY_CURL_SNIPPET =
  "curl --header 'Authorization: Bearer token-only'";
const SOAP_RESPONSE_URL = "https://api.example.com/soap/login";
const SOAP_RESPONSE_PREVIEW = "<Envelope>ok</Envelope>";
const EMPTY_SMOKE_TEST_MESSAGE =
  "Run a smoke test to execute the selected requests once and inspect the response body, headers, and status before starting load.";

const dialogMocks = vi.hoisted(() => ({
  selectReportSavePath: vi.fn(),
}));

vi.mock("../features/import/useCollectionImport", () => ({
  useCollectionImport: () => appHookTestState.importHookState,
}));

vi.mock("../features/test/useTestHarness", () => ({
  useTestHarness: () => appHookTestState.testHookState,
}));

vi.mock("../lib/tauri/dialog", () => ({
  selectCollectionFile: vi.fn(),
  selectReportSavePath: dialogMocks.selectReportSavePath,
}));

function createSoapSmokeResponse(
  overrides: Partial<SmokeTestResponse["responses"][number]> = {},
): SmokeTestResponse {
  return {
    responses: [
      {
        requestId: "request-0",
        requestName: "SOAP login",
        method: "POST",
        url: SOAP_RESPONSE_URL,
        statusCode: 200,
        durationMs: 42,
        ok: true,
        contentType: "text/xml; charset=utf-8",
        responseHeaders: {
          "content-type": "text/xml; charset=utf-8",
        },
        bodyPreview: SOAP_RESPONSE_PREVIEW,
        errorMessage: null,
        ...overrides,
      },
    ],
  };
}

function applyCurlSnippet(snippet: string) {
  fireEvent.change(screen.getByLabelText("Paste Postman cURL"), {
    target: {
      value: snippet,
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Extract URL & Token" }));
}

async function advanceValidationTimer() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}

async function flushMicrotasks(count = 1) {
  await act(async () => {
    for (let index = 0; index < count; index += 1) {
      await Promise.resolve();
    }
  });
}

function getLatestResultCard() {
  const latestResultCard = screen.getByText("Latest Result").closest(".result-summary");
  expect(latestResultCard).not.toBeNull();
  return latestResultCard as HTMLElement;
}

function getLiveRunMonitor() {
  return screen.getByLabelText("Live run monitor");
}

function createCompletedResult(): TestResult {
  return {
    status: "passed",
    metrics: {
      totalRequests: 50,
      failedRequests: 0,
      avgResponseTime: 120,
      p50ResponseTime: 100,
      p95ResponseTime: 180,
      maxResponseTime: 240,
      requestsPerSecond: 8.5,
    },
    thresholds: [],
  };
}

describe("App validation lifecycle", () => {
  beforeEach(() => {
    resetAppTestEnvironment();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores stale ready responses after settings change until the next validation completes", async () => {
    const validations: Array<ReturnType<typeof deferred<{ ready: boolean; message: string }>>> =
      [];
    const api: LoadRiftApi = createApiMock({
      validateTestConfiguration: vi.fn((_input: { options: K6Options }) => {
        const next = deferred<{ ready: boolean; message: string }>();
        validations.push(next);
        return next.promise;
      }),
    });

    renderApp(api);

    const startButton = screen.getByRole("button", { name: "Start Test" });
    const durationInput = screen.getByLabelText("Duration");

    expect(startButton).toBeDisabled();
    expect(screen.getByText("Validating current configuration...")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(api.validateTestConfiguration).toHaveBeenCalledTimes(1);

    fireEvent.change(durationInput, { target: { value: "2m" } });

    expect(startButton).toBeDisabled();
    expect(screen.getByText("Validating current configuration...")).toBeInTheDocument();

    await act(async () => {
      const firstValidation = validations[0];
      expect(firstValidation).toBeDefined();
      firstValidation?.resolve({
        ready: true,
        message: "Configuration looks ready to run.",
      });
      await Promise.resolve();
    });

    expect(startButton).toBeDisabled();
    expect(screen.getByText("Validating current configuration...")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(api.validateTestConfiguration).toHaveBeenCalledTimes(2);
    const secondValidationCall = (
      api.validateTestConfiguration as ReturnType<typeof vi.fn>
    ).mock.calls[1];
    expect(secondValidationCall).toBeDefined();
    expect(secondValidationCall?.[0].options.duration).toBe("2m");

    await act(async () => {
      const secondValidation = validations[1];
      expect(secondValidation).toBeDefined();
      secondValidation?.resolve({
        ready: true,
        message: "Configuration looks ready to run.",
      });
      await Promise.resolve();
    });

    expect(startButton).toBeEnabled();
    expect(screen.getByText("Configuration looks ready to run.")).toBeInTheDocument();
  });

  it("allows temporary invalid virtual user edits while blocking Start Test", async () => {
    const api = createApiMock();

    renderApp(api);

    await advanceValidationTimer();

    const startButton = screen.getByRole("button", { name: "Start Test" });
    const checkConfigButton = screen.getByRole("button", { name: "Check Config" });
    expect(startButton).toBeEnabled();
    expect(checkConfigButton).toBeEnabled();

    const vusInput = screen.getByLabelText("Virtual users");
    fireEvent.change(vusInput, { target: { value: "" } });

    expect(screen.getByText("Virtual users is required.")).toBeInTheDocument();
    expect(screen.getByText("Fix the highlighted runner inputs before starting.")).toBeInTheDocument();
    expect(
      screen.getByText("Fix the highlighted runner inputs before checking configuration or starting."),
    ).toBeInTheDocument();
    expect(startButton).toBeDisabled();
    expect(checkConfigButton).toBeDisabled();

    fireEvent.change(vusInput, { target: { value: "3.5" } });

    expect(
      screen.getByText("Virtual users must be a whole number of 1 or more."),
    ).toBeInTheDocument();
    expect(startButton).toBeDisabled();
    expect(checkConfigButton).toBeDisabled();

    fireEvent.change(vusInput, { target: { value: "9007199254740992" } });

    expect(
      screen.getByText("Virtual users must be a whole number of 1 or more."),
    ).toBeInTheDocument();
    expect(startButton).toBeDisabled();
    expect(checkConfigButton).toBeDisabled();

    fireEvent.change(vusInput, { target: { value: "25" } });

    await advanceValidationTimer();

    expect(startButton).toBeEnabled();
    expect(checkConfigButton).toBeEnabled();
    const lastValidationCall = vi.mocked(api.validateTestConfiguration).mock.lastCall;
    expect(lastValidationCall).toBeDefined();
    expect(lastValidationCall?.[0].options.vus).toBe(25);
  });

  it("requires threshold inputs to be whole numbers before starting", async () => {
    const api = createApiMock();

    renderApp(api);

    await advanceValidationTimer();

    const startButton = screen.getByRole("button", { name: "Start Test" });
    expect(startButton).toBeEnabled();

    const p95ThresholdInput = screen.getByLabelText("P95 threshold (ms)");

    fireEvent.change(p95ThresholdInput, {
      target: { value: "2000.5" },
    });

    expect(
      screen.getByText("P95 threshold must be a whole number of milliseconds."),
    ).toBeInTheDocument();
    expect(startButton).toBeDisabled();

    fireEvent.change(p95ThresholdInput, {
      target: { value: "2001" },
    });

    await advanceValidationTimer();

    expect(startButton).toBeEnabled();
    const lastValidationCall = vi.mocked(api.validateTestConfiguration).mock.lastCall;
    expect(lastValidationCall).toBeDefined();
    expect(lastValidationCall?.[0].options.thresholds.p95ResponseTime).toBe(2001);
  });

  it("applies base URL and bearer token from a pasted curl command", () => {
    renderApp(createApiMock());

    applyCurlSnippet(DEFAULT_CURL_SNIPPET);

    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "https://api.example.com",
    );
    expect((screen.getByLabelText("Bearer token / JWT") as HTMLInputElement).value).toBe(
      "integration-token",
    );
    expect(
      screen.getByText(/Extracted base URL https:\/\/api\.example\.com and bearer token/),
    ).toHaveTextContent("cleared to avoid keeping tokens on screen");
    expect((screen.getByLabelText("Paste Postman cURL") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(screen.getByRole("tab", { name: "Variables" }));
    expect((screen.getByLabelText("Environment") as HTMLInputElement).value).toBe(
      "https://api.example.com",
    );
  });

  it("allows manual base URL edits for host-style variables without persisting mirrored overrides", async () => {
    const api = createApiMock();

    renderApp(api);

    await advanceValidationTimer();
    vi.mocked(api.validateTestConfiguration).mockClear();

    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: " https://manual.example.com " },
    });

    await advanceValidationTimer();

    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      " https://manual.example.com ",
    );
    expect(api.validateTestConfiguration).toHaveBeenCalledTimes(1);
    expect(
      (api.validateTestConfiguration as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].options,
    ).toMatchObject({
      baseUrl: "https://manual.example.com",
      variableOverrides: {},
    });

    fireEvent.click(screen.getByRole("tab", { name: "Variables" }));
    expect((screen.getByLabelText("Environment") as HTMLInputElement).value).toBe(
      "https://manual.example.com",
    );

    fireEvent.click(screen.getByRole("button", { name: "Start Test" }));
    expect(appHookTestState.testHookState.startTest).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://manual.example.com" }),
    );
  });

  it("uses the cURL-applied base URL for host-style variables without persisting mirrored overrides", async () => {
    const api = createApiMock();

    renderApp(api);

    await advanceValidationTimer();
    vi.mocked(api.validateTestConfiguration).mockClear();

    applyCurlSnippet(DEFAULT_CURL_SNIPPET);

    await advanceValidationTimer();

    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "https://api.example.com",
    );
    expect(api.validateTestConfiguration).toHaveBeenCalledTimes(1);
    expect(
      (api.validateTestConfiguration as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].options,
    ).toMatchObject({
      baseUrl: "https://api.example.com",
      variableOverrides: {},
    });
  });

  it("hides empty host-style variable warnings once a derived base URL is available", () => {
    renderApp(createApiMock());

    fireEvent.click(screen.getByRole("tab", { name: "Variables" }));

    expect(screen.getByText(/Empty variables:\s*environment\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Controls" }));
    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);

    fireEvent.click(screen.getByRole("tab", { name: "Variables" }));
    expect(screen.queryByText(/Empty variables:\s*environment\./)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Controls" }));
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "https://api.example.com",
    );
  });

  it("shows an idle verdict before any test has started", () => {
    const api = createApiMock({
      validateTestConfiguration: vi.fn(async () => ({
        ready: false,
        message:
          "Apply a Postman cURL snippet to derive the base URL required by this collection.",
      })),
    });

    renderApp(api);

    expect(screen.getByText("Runner").closest(".overview-card")).toHaveTextContent("IDLE");
    expect(screen.getByText("Live metrics")).toBeInTheDocument();
    expect(screen.getByLabelText("Live run metrics overview")).toHaveTextContent("Active VUs");
    expect(screen.queryByText("Run State")).not.toBeInTheDocument();
    expect(screen.queryByText("Verdict")).not.toBeInTheDocument();
    expect(screen.queryByText("PENDING")).not.toBeInTheDocument();
  });

  it("blocks run readiness while advanced JSON is invalid", async () => {
    const api = createApiMock();

    renderApp(api);

    await advanceValidationTimer();

    const startButton = screen.getByRole("button", { name: "Start Test" });
    const smokeButton = screen.getByRole("button", { name: "Smoke Test" });
    const checkConfigButton = screen.getByRole("button", { name: "Check Config" });
    expect(startButton).toBeEnabled();
    expect(smokeButton).toBeEnabled();
    expect(checkConfigButton).toBeEnabled();

    vi.mocked(api.validateTestConfiguration).mockClear();
    vi.mocked(api.smokeTestRequests).mockClear();

    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    fireEvent.change(screen.getByLabelText("Advanced options JSON"), {
      target: { value: "{bad" },
    });

    expect(screen.getByText(/Invalid JSON:/)).toBeInTheDocument();
    expect(screen.getByText("Fix the highlighted runner inputs before starting.")).toBeInTheDocument();
    expect(startButton).toBeDisabled();
    expect(smokeButton).toBeDisabled();
    expect(checkConfigButton).toBeDisabled();

    await advanceValidationTimer();

    expect(api.validateTestConfiguration).not.toHaveBeenCalled();
    fireEvent.click(smokeButton);
    expect(api.smokeTestRequests).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Advanced options JSON"), {
      target: { value: '{"tags":{"team":"qa"}}' },
    });

    expect(screen.getByText("JSON syntax looks valid.")).toBeInTheDocument();

    await advanceValidationTimer();

    expect(startButton).toBeEnabled();
    expect(checkConfigButton).toBeEnabled();
  });

  it("shows k6 primary error, fallback context, and finish reason", () => {
    const primaryError =
      "The moduleSpecifier \"/tmp/loadrift/run/script.js\" couldn't be found on local disk.";
    const summaryIssue = "summary.json was not written before k6 exited";
    const fallbackResult: TestResult = {
      status: "warning",
      metrics: {
        totalRequests: 3,
        failedRequests: 1,
        avgResponseTime: 120,
        p50ResponseTime: 100,
        p95ResponseTime: 180,
        maxResponseTime: 220,
        requestsPerSecond: 1.5,
      },
      thresholds: [],
    };

    appHookTestState.testHookState.state = {
      ...appHookTestState.testHookState.state,
      status: "failed",
      result: fallbackResult,
      finishReason: "execution_error",
      resultSource: "liveMetricsFallback",
      summaryIssue,
      error: primaryError,
    };

    renderApp(createApiMock());

    expect(screen.getAllByText(`Primary k6 error: ${primaryError}`)).not.toHaveLength(0);
    expect(screen.getByText("Finish reason: execution_error")).toBeInTheDocument();
    expect(screen.getByText(/Latest result uses live metrics fallback/)).toHaveTextContent(
      summaryIssue,
    );
    expect(screen.getByText("Result source").closest("p")).toHaveTextContent(
      "Live metrics fallback",
    );
    expect(screen.getByText("Fallback context").closest("p")).toHaveTextContent(
      summaryIssue,
    );
  });

  it("runs a smoke test, disables conflicting actions, and shows the returned SOAP preview", async () => {
    const smokeResponse = createSoapSmokeResponse();
    const smokeRequest = deferred<SmokeTestResponse>();
    const api = createApiMock({
      smokeTestRequests: vi.fn(() => smokeRequest.promise),
    });

    renderApp(api);

    await advanceValidationTimer();

    const startButton = screen.getByRole("button", { name: "Start Test" });
    const smokeButton = screen.getByRole("button", { name: "Smoke Test" });

    expect(startButton).toBeEnabled();

    fireEvent.click(smokeButton);

    expect(api.smokeTestRequests).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Running the selected requests once to capture live response samples.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Smoking..." })).toBeDisabled();
    expect(startButton).toBeDisabled();

    await act(async () => {
      smokeRequest.resolve(smokeResponse);
      await smokeRequest.promise;
    });

    expect(screen.getByText("SOAP login")).toBeInTheDocument();
    expect(screen.getByText(`POST ${SOAP_RESPONSE_URL}`)).toBeInTheDocument();
    expect(screen.getByText(SOAP_RESPONSE_PREVIEW)).toBeInTheDocument();
  });

  it("clears smoke test results when starting a load test", async () => {
    const smokeResponse = createSoapSmokeResponse();
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => smokeResponse),
    });

    renderApp(api);

    await advanceValidationTimer();

    fireEvent.click(screen.getByRole("button", { name: "Smoke Test" }));

    await flushMicrotasks();

    expect(screen.getByText(SOAP_RESPONSE_PREVIEW)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start Test" }));

    expect(appHookTestState.testHookState.startTest).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(SOAP_RESPONSE_PREVIEW)).not.toBeInTheDocument();
    expect(screen.getByText(EMPTY_SMOKE_TEST_MESSAGE)).toBeInTheDocument();
  });

  it("keeps the harness busy when smoke-test inputs change mid-flight", async () => {
    const smokeRequest = deferred<SmokeTestResponse>();
    const api = createApiMock({
      smokeTestRequests: vi.fn(() => smokeRequest.promise),
    });

    renderApp(api);

    await advanceValidationTimer();

    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);

    fireEvent.click(screen.getByRole("button", { name: "Smoke Test" }));

    expect(screen.getByRole("button", { name: "Smoking..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start Test" })).toBeDisabled();

    applyCurlSnippet(CHANGED_BASE_URL_CURL_SNIPPET);

    expect(screen.getByRole("button", { name: "Smoking..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start Test" })).toBeDisabled();

    await act(async () => {
      smokeRequest.resolve(createSoapSmokeResponse());
      await smokeRequest.promise;
    });

    expect(screen.queryByText(SOAP_RESPONSE_PREVIEW)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Smoke Test" })).toBeEnabled();
  });

  it("keeps smoke test results visible when only load settings change", async () => {
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => createSoapSmokeResponse()),
    });

    renderApp(api);

    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);
    fireEvent.click(screen.getByRole("button", { name: "Smoke Test" }));

    await flushMicrotasks();

    expect(screen.getByText(SOAP_RESPONSE_PREVIEW)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Virtual users"), {
      target: {
        value: "25",
      },
    });
    fireEvent.change(screen.getByLabelText("Duration"), {
      target: {
        value: "2m",
      },
    });

    expect(screen.getByText(SOAP_RESPONSE_PREVIEW)).toBeInTheDocument();
  });

  it("clears stale smoke test results when smoke-request inputs change", async () => {
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => createSoapSmokeResponse()),
    });

    renderApp(api);

    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);

    fireEvent.click(screen.getByRole("button", { name: "Smoke Test" }));

    await flushMicrotasks();

    expect(screen.getByText(SOAP_RESPONSE_PREVIEW)).toBeInTheDocument();

    await act(async () => {
      applyCurlSnippet(CHANGED_BASE_URL_CURL_SNIPPET);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText(SOAP_RESPONSE_PREVIEW)).not.toBeInTheDocument();
    expect(screen.getByText(EMPTY_SMOKE_TEST_MESSAGE)).toBeInTheDocument();
  });

  it("discards smoke test results when inputs change before the response returns", async () => {
    const smokeRequest = deferred<SmokeTestResponse>();
    const api = createApiMock({
      smokeTestRequests: vi.fn(() => smokeRequest.promise),
    });

    renderApp(api);

    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);

    fireEvent.click(screen.getByRole("button", { name: "Smoke Test" }));

    await act(async () => {
      applyCurlSnippet(CHANGED_BASE_URL_CURL_SNIPPET);
      smokeRequest.resolve(createSoapSmokeResponse());
      await smokeRequest.promise;
      await Promise.resolve();
    });

    await flushMicrotasks();

    expect(screen.queryByText(SOAP_RESPONSE_PREVIEW)).not.toBeInTheDocument();
  });

  it("clears smoke test results after re-import when collection defaults change", async () => {
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => createSoapSmokeResponse()),
    });

    appHookTestState.importHookState = createImportHookState({
      ...importedCollection,
      runtimeVariables: [
        {
          key: "environment",
          defaultValue: "https://api.example.com",
        },
      ],
    });

    const view = renderApp(api);

    fireEvent.click(screen.getByRole("button", { name: "Smoke Test" }));

    await flushMicrotasks();

    expect(screen.getByText(SOAP_RESPONSE_PREVIEW)).toBeInTheDocument();

    appHookTestState.importHookState = createImportHookState({
      ...importedCollection,
      runtimeVariables: [
        {
          key: "environment",
          defaultValue: "https://api.changed.example.com",
        },
      ],
    });
    view.rerender(createAppElement(api));

    await flushMicrotasks();

    expect(screen.queryByText(SOAP_RESPONSE_PREVIEW)).not.toBeInTheDocument();
  });

  it("clears smoke test results after re-import even when the visible summary is unchanged", async () => {
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => createSoapSmokeResponse()),
    });

    appHookTestState.importHookState = createImportHookState({
      ...importedCollection,
      requests: importedCollection.requests.map((request) => ({ ...request })),
      runtimeVariables: importedCollection.runtimeVariables.map((variable) => ({
        ...variable,
      })),
    });

    const view = renderApp(api);

    fireEvent.click(screen.getByRole("button", { name: "Smoke Test" }));

    await flushMicrotasks();

    expect(screen.getByText(SOAP_RESPONSE_PREVIEW)).toBeInTheDocument();

    appHookTestState.importHookState = createImportHookState({
      ...importedCollection,
      requests: importedCollection.requests.map((request) => ({ ...request })),
      runtimeVariables: importedCollection.runtimeVariables.map((variable) => ({
        ...variable,
      })),
    });
    view.rerender(createAppElement(api));

    await flushMicrotasks();

    expect(screen.queryByText(SOAP_RESPONSE_PREVIEW)).not.toBeInTheDocument();
  });

  it("preserves existing fields when a later cURL command omits them", () => {
    renderApp(createApiMock());

    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);

    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "https://api.example.com",
    );

    applyCurlSnippet(TOKEN_ONLY_CURL_SNIPPET);

    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "https://api.example.com",
    );
    expect((screen.getByLabelText("Bearer token / JWT") as HTMLInputElement).value).toBe(
      "token-only",
    );
  });

  it("prompts for a report destination from the latest result card before exporting", async () => {
    const longSavePath =
      "/tmp/loadrift/reports/releases/very-long-directory-name-without-natural-breaks/loadrift-report-api-example-com-20260325-151332.html";
    dialogMocks.selectReportSavePath.mockResolvedValue(longSavePath);
    const api = createApiMock({
      exportReport: vi.fn(async () => undefined),
    });

    renderApp(api);

    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);

    const latestResultCard = getLatestResultCard();
    const liveRunMonitor = getLiveRunMonitor();
    const exportButton = within(latestResultCard).getByRole("button", {
      name: "Export Latest Report",
    });

    expect(
      within(liveRunMonitor).queryByRole("button", { name: "Export Latest Report" }),
    ).not.toBeInTheDocument();

    fireEvent.click(exportButton);

    await act(async () => {
      await Promise.resolve();
    });

    const successMessage = `Report saved to ${longSavePath}.`;

    expect(dialogMocks.selectReportSavePath).toHaveBeenCalledTimes(1);
    expect(dialogMocks.selectReportSavePath).toHaveBeenCalledWith(
      "loadrift-report-api-example-com-20260325-151332.html",
    );
    expect(api.exportReport).toHaveBeenCalledWith({
      savePath: longSavePath,
    });
    expect(within(latestResultCard).getByText(/Export uses the latest backend report/)).toBeInTheDocument();
    const notice = within(latestResultCard).getByRole("status");
    expect(notice).toHaveTextContent(successMessage);
    expect(notice).toHaveClass("export-notice");
    expect(within(liveRunMonitor).queryByText(successMessage)).not.toBeInTheDocument();
  });

  it("keeps result-state export controls and notices in the latest result card", async () => {
    dialogMocks.selectReportSavePath.mockResolvedValue("/tmp/loadrift-report.html");
    const api = createApiMock({
      exportReport: vi.fn(async () => undefined),
    });

    appHookTestState.testHookState.state = {
      ...appHookTestState.testHookState.state,
      status: "completed",
      result: createCompletedResult(),
    };

    renderApp(api);

    const latestResultCard = getLatestResultCard();
    const liveRunMonitor = getLiveRunMonitor();
    const exportButton = within(latestResultCard).getByRole("button", {
      name: "Export Latest Report",
    });

    expect(
      within(liveRunMonitor).queryByRole("button", { name: "Export Latest Report" }),
    ).not.toBeInTheDocument();

    fireEvent.click(exportButton);

    await flushMicrotasks(2);

    const successMessage = "Report saved to /tmp/loadrift-report.html.";
    expect(within(latestResultCard).getByRole("status")).toHaveTextContent(successMessage);
    expect(within(liveRunMonitor).queryByText(successMessage)).not.toBeInTheDocument();
  });

  it("shows export failures in the latest result card", async () => {
    dialogMocks.selectReportSavePath.mockResolvedValue("/tmp/loadrift-report.html");
    const api = createApiMock({
      exportReport: vi.fn(async () => {
        throw new Error("Run a k6 test before exporting a report.");
      }),
    });

    renderApp(api);

    const latestResultCard = getLatestResultCard();
    const liveRunMonitor = getLiveRunMonitor();

    expect(
      within(liveRunMonitor).queryByRole("button", { name: "Export Latest Report" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(latestResultCard).getByRole("button", { name: "Export Latest Report" }),
    );

    await flushMicrotasks(2);

    const failureMessage = "Run a k6 test before exporting a report.";
    const notice = within(latestResultCard).getByRole("alert");
    expect(notice).toHaveTextContent(failureMessage);
    expect(notice).toHaveClass("export-notice");
    expect(within(liveRunMonitor).queryByText(failureMessage)).not.toBeInTheDocument();
  });
});
