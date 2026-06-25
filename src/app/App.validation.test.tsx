import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadRiftApi } from "../lib/loadrift/api";
import type {
  K6Options,
  SmokeTestResponse,
  TestResult,
} from "../lib/loadrift/types";
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
const FIRST_HEADER_CURL_SNIPPET =
  "curl --location 'https://api.example.com/entities/alpha' --header 'X-Trace: first'";
const SECOND_HEADER_CURL_SNIPPET =
  "curl --location 'https://api.example.com/entities/alpha' --header 'X-Run: second'";
const POSTMAN_REQUEST_DETAILS_CURL_SNIPPET = `curl --location 'https://acc.crvherdoptimizer.com/breeding-catalog/catalog/api/module/build' \\
--header 'Customerid: f47ac10b-58cc-4372-a567-0e02b2c3d479' \\
--header 'Modulename: Inbreeding' \\
--header 'Applicationname: herdoptimizer' \\
--header 'Content-Type: application/json' \\
--header 'Authorization: Bearer e.' \\
--data '{"module":"Inbreeding"}'`;
const SOAP_RESPONSE_URL = "https://api.example.com/soap/login";
const SOAP_RESPONSE_PREVIEW = "<Envelope>ok</Envelope>";
const EMPTY_SMOKE_TEST_MESSAGE =
  "Run a smoke test to execute the selected requests once and inspect the response body, headers, and status before starting load.";

vi.mock("../features/import/useCollectionImport", () => ({
  useCollectionImport: () => appHookTestState.importHookState,
}));

vi.mock("../features/test/useTestHarness", () => ({
  useTestHarness: () => appHookTestState.testHookState,
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
  openWorkflowStep("Configure");
  fireEvent.click(screen.getByRole("tab", { name: "Controls" }));
  fireEvent.change(screen.getByLabelText("Paste Postman cURL"), {
    target: {
      value: snippet,
    },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Apply Request Details" }),
  );
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
  openWorkflowStep("Run");
  const latestResultCard = screen
    .getByText("Latest Result")
    .closest(".result-summary");
  expect(latestResultCard).not.toBeNull();
  return latestResultCard as HTMLElement;
}

function getLiveRunMonitor() {
  openWorkflowStep("Run");
  return screen.getByLabelText("Live run monitor");
}

function openWorkflowStep(step: "Source" | "Configure" | "Run") {
  act(() => {
    fireEvent.click(screen.getByRole("tab", { name: new RegExp(step) }));
  });
}

function getRunAction(name: string | RegExp) {
  openWorkflowStep("Run");
  return screen.getByRole("button", { name });
}

function getConfigureField(label: string) {
  openWorkflowStep("Configure");
  return screen.getByLabelText(label);
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
    const validations: Array<
      ReturnType<typeof deferred<{ ready: boolean; message: string }>>
    > = [];
    const api: LoadRiftApi = createApiMock({
      validateTestConfiguration: vi.fn((_input: { options: K6Options }) => {
        const next = deferred<{ ready: boolean; message: string }>();
        validations.push(next);
        return next.promise;
      }),
    });

    renderApp(api);

    expect(getRunAction("Start Test")).toBeDisabled();
    openWorkflowStep("Configure");
    expect(
      screen.getByText("Validating current configuration..."),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(api.validateTestConfiguration).toHaveBeenCalledTimes(1);

    fireEvent.change(getConfigureField("Duration"), {
      target: { value: "2m" },
    });

    openWorkflowStep("Configure");
    expect(
      screen.getByText("Validating current configuration..."),
    ).toBeInTheDocument();
    expect(getRunAction("Start Test")).toBeDisabled();

    await act(async () => {
      const firstValidation = validations[0];
      expect(firstValidation).toBeDefined();
      firstValidation?.resolve({
        ready: true,
        message: "Configuration looks ready to run.",
      });
      await Promise.resolve();
    });

    openWorkflowStep("Configure");
    expect(
      screen.getByText("Validating current configuration..."),
    ).toBeInTheDocument();
    expect(getRunAction("Start Test")).toBeDisabled();

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

    expect(getRunAction("Start Test")).toBeEnabled();
    openWorkflowStep("Configure");
    expect(
      screen.getByText("Configuration looks ready to run."),
    ).toBeInTheDocument();
  });

  it("allows temporary invalid virtual user edits while blocking Start Test", async () => {
    const api = createApiMock();

    renderApp(api);

    await advanceValidationTimer();

    expect(getRunAction("Start Test")).toBeEnabled();
    expect(getRunAction("Check Config")).toBeEnabled();

    fireEvent.change(getConfigureField("Virtual users"), {
      target: { value: "" },
    });

    expect(screen.getByText("Virtual users is required.")).toBeInTheDocument();
    expect(getRunAction("Start Test")).toBeDisabled();
    expect(
      screen.getByText("Fix the highlighted runner inputs before starting."),
    ).toBeInTheDocument();
    openWorkflowStep("Configure");
    expect(
      screen.getByText(
        "Fix the highlighted runner inputs before checking configuration or starting.",
      ),
    ).toBeInTheDocument();
    expect(getRunAction("Check Config")).toBeDisabled();

    fireEvent.change(getConfigureField("Virtual users"), {
      target: { value: "3.5" },
    });

    expect(
      screen.getByText("Virtual users must be a whole number of 1 or more."),
    ).toBeInTheDocument();
    expect(getRunAction("Start Test")).toBeDisabled();
    expect(getRunAction("Check Config")).toBeDisabled();

    fireEvent.change(getConfigureField("Virtual users"), {
      target: { value: "9007199254740992" },
    });

    expect(
      screen.getByText("Virtual users must be a whole number of 1 or more."),
    ).toBeInTheDocument();
    expect(getRunAction("Start Test")).toBeDisabled();
    expect(getRunAction("Check Config")).toBeDisabled();

    fireEvent.change(getConfigureField("Virtual users"), {
      target: { value: "25" },
    });

    await advanceValidationTimer();

    expect(getRunAction("Start Test")).toBeEnabled();
    expect(getRunAction("Check Config")).toBeEnabled();
    const lastValidationCall = vi.mocked(api.validateTestConfiguration).mock
      .lastCall;
    expect(lastValidationCall).toBeDefined();
    expect(lastValidationCall?.[0].options.vus).toBe(25);
  });

  it("requires threshold inputs to be whole numbers before starting", async () => {
    const api = createApiMock();

    renderApp(api);

    await advanceValidationTimer();

    expect(getRunAction("Start Test")).toBeEnabled();

    fireEvent.change(getConfigureField("P95 threshold (ms)"), {
      target: { value: "2000.5" },
    });

    expect(
      screen.getByText("P95 threshold must be a whole number of milliseconds."),
    ).toBeInTheDocument();
    expect(getRunAction("Start Test")).toBeDisabled();

    fireEvent.change(getConfigureField("P95 threshold (ms)"), {
      target: { value: "2001" },
    });

    await advanceValidationTimer();

    expect(getRunAction("Start Test")).toBeEnabled();
    const lastValidationCall = vi.mocked(api.validateTestConfiguration).mock
      .lastCall;
    expect(lastValidationCall).toBeDefined();
    expect(lastValidationCall?.[0].options.thresholds.p95ResponseTime).toBe(
      2001,
    );
  });

  it("applies base URL and bearer token from a pasted curl command", () => {
    renderApp(createApiMock());

    applyCurlSnippet(DEFAULT_CURL_SNIPPET);

    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "https://api.example.com",
    );
    expect(
      (screen.getByLabelText("Bearer token / JWT") as HTMLInputElement).value,
    ).toBe("integration-token");
    expect(
      screen.getByText(
        /Applied base URL https:\/\/api\.example\.com and bearer token/,
      ),
    ).toHaveTextContent("cleared to avoid keeping tokens on screen");
    expect(
      (screen.getByLabelText("Paste Postman cURL") as HTMLTextAreaElement)
        .value,
    ).toBe("");
    fireEvent.click(screen.getByRole("tab", { name: "Variables" }));
    expect(
      (screen.getByLabelText("Environment") as HTMLInputElement).value,
    ).toBe("https://api.example.com");
  });

  it("applies cURL headers and a single-request body override to validation, smoke, and start options", async () => {
    const api = createApiMock();

    renderApp(api);

    await advanceValidationTimer();
    vi.mocked(api.validateTestConfiguration).mockClear();

    applyCurlSnippet(POSTMAN_REQUEST_DETAILS_CURL_SNIPPET);

    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "https://acc.crvherdoptimizer.com",
    );
    expect(
      (screen.getByLabelText("Bearer token / JWT") as HTMLInputElement).value,
    ).toBe("e.");
    expect(screen.getByDisplayValue("Customerid")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("f47ac10b-58cc-4372-a567-0e02b2c3d479"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Applied base URL https:\/\/acc\.crvherdoptimizer\.com, bearer token, 4 request headers, and request body override/,
      ),
    ).toBeInTheDocument();

    await advanceValidationTimer();

    const expectedOptions: Partial<K6Options> = {
      baseUrl: "https://acc.crvherdoptimizer.com",
      authToken: "e.",
      requestHeaders: {
        Customerid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        Modulename: "Inbreeding",
        Applicationname: "herdoptimizer",
        "Content-Type": "application/json",
      },
      requestBodyOverride: {
        requestId: "request-0",
        body: '{"module":"Inbreeding"}',
      },
    };

    const validationCalls = vi.mocked(api.validateTestConfiguration).mock
      .calls as Array<[{ options: K6Options }]>;
    const validationOptions =
      validationCalls[validationCalls.length - 1]?.[0].options;
    expect(validationOptions).toMatchObject(expectedOptions);

    fireEvent.click(getRunAction("Smoke Test"));
    const smokeCalls = vi.mocked(api.smokeTestRequests).mock.calls as Array<
      [{ options: K6Options }]
    >;
    const smokeOptions = smokeCalls[smokeCalls.length - 1]?.[0].options;
    expect(smokeOptions).toMatchObject(expectedOptions);

    await flushMicrotasks();

    fireEvent.click(getRunAction("Start Test"));
    expect(appHookTestState.testHookState.startTest).toHaveBeenCalledWith(
      expect.objectContaining(expectedOptions),
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
      (api.validateTestConfiguration as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0].options,
    ).toMatchObject({
      baseUrl: "https://manual.example.com",
      variableOverrides: {},
    });

    fireEvent.click(screen.getByRole("tab", { name: "Variables" }));
    expect(
      (screen.getByLabelText("Environment") as HTMLInputElement).value,
    ).toBe("https://manual.example.com");

    fireEvent.click(getRunAction("Start Test"));
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
      (api.validateTestConfiguration as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0].options,
    ).toMatchObject({
      baseUrl: "https://api.example.com",
      variableOverrides: {},
    });
  });

  it("hides empty host-style variable warnings once a derived base URL is available", () => {
    renderApp(createApiMock());

    fireEvent.click(screen.getByRole("tab", { name: "Variables" }));

    expect(
      screen.getByText(/Empty variables:\s*environment\./),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Controls" }));
    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);

    fireEvent.click(screen.getByRole("tab", { name: "Variables" }));
    expect(
      screen.queryByText(/Empty variables:\s*environment\./),
    ).not.toBeInTheDocument();
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

    expect(
      screen.getByText("Runner").closest(".overview-card"),
    ).toHaveTextContent("IDLE");
    openWorkflowStep("Run");
    expect(screen.getByText("Live metrics")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Live run metrics overview"),
    ).toHaveTextContent("Active VUs");
    expect(screen.queryByText("Run State")).not.toBeInTheDocument();
    expect(screen.queryByText("Verdict")).not.toBeInTheDocument();
    expect(screen.queryByText("PENDING")).not.toBeInTheDocument();
  });

  it("blocks run readiness while advanced JSON is invalid", async () => {
    const api = createApiMock();

    renderApp(api);

    await advanceValidationTimer();

    const startButton = getRunAction("Start Test");
    const smokeButton = getRunAction("Smoke Test");
    const checkConfigButton = getRunAction("Check Config");
    expect(startButton).toBeEnabled();
    expect(smokeButton).toBeEnabled();
    expect(checkConfigButton).toBeEnabled();

    vi.mocked(api.validateTestConfiguration).mockClear();
    vi.mocked(api.smokeTestRequests).mockClear();

    openWorkflowStep("Configure");
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    fireEvent.change(screen.getByLabelText("Advanced options JSON"), {
      target: { value: "{bad" },
    });

    expect(getRunAction("Start Test")).toBeDisabled();
    expect(
      screen.getByText("Fix the highlighted runner inputs before starting."),
    ).toBeInTheDocument();
    expect(getRunAction("Smoke Test")).toBeDisabled();
    expect(getRunAction("Check Config")).toBeDisabled();
    openWorkflowStep("Configure");
    expect(screen.getByText(/Invalid JSON:/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Fix the highlighted runner inputs before checking configuration or starting.",
      ),
    ).toBeInTheDocument();

    await advanceValidationTimer();

    expect(api.validateTestConfiguration).not.toHaveBeenCalled();
    fireEvent.click(getRunAction("Smoke Test"));
    expect(api.smokeTestRequests).not.toHaveBeenCalled();

    openWorkflowStep("Configure");
    fireEvent.change(screen.getByLabelText("Advanced options JSON"), {
      target: { value: '{"tags":{"team":"qa"}}' },
    });

    expect(screen.getByText("JSON syntax looks valid.")).toBeInTheDocument();

    await advanceValidationTimer();

    expect(getRunAction("Start Test")).toBeEnabled();
    expect(getRunAction("Check Config")).toBeEnabled();
  });

  it("shows k6 primary error, fallback context, and finish reason", () => {
    const primaryError =
      'The moduleSpecifier "/tmp/loadrift/run/script.js" couldn\'t be found on local disk.';
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

    openWorkflowStep("Run");
    expect(
      screen.getAllByText(`Primary k6 error: ${primaryError}`),
    ).not.toHaveLength(0);
    expect(
      screen.getByText("Finish reason: execution_error"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Latest result uses live metrics fallback/),
    ).toHaveTextContent(summaryIssue);
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

    const startButton = getRunAction("Start Test");
    const smokeButton = getRunAction("Smoke Test");

    expect(startButton).toBeEnabled();

    fireEvent.click(smokeButton);

    expect(api.smokeTestRequests).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        "Running the selected requests once to capture live response samples.",
      ),
    ).toBeInTheDocument();
    expect(getRunAction("Smoke testing...")).toBeDisabled();
    expect(startButton).toBeDisabled();

    await act(async () => {
      smokeRequest.resolve(smokeResponse);
      await smokeRequest.promise;
    });

    expect(screen.getByText("SOAP login")).toBeInTheDocument();
    expect(screen.getByText(`POST ${SOAP_RESPONSE_URL}`)).toBeInTheDocument();
    openWorkflowStep("Run");
    expect(screen.getByText(SOAP_RESPONSE_PREVIEW)).toBeInTheDocument();
  });

  it("clears smoke test results when starting a load test", async () => {
    const smokeResponse = createSoapSmokeResponse();
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => smokeResponse),
    });

    renderApp(api);

    await advanceValidationTimer();

    fireEvent.click(getRunAction("Smoke Test"));

    await flushMicrotasks();

    openWorkflowStep("Run");
    expect(screen.getByText(SOAP_RESPONSE_PREVIEW)).toBeInTheDocument();

    fireEvent.click(getRunAction("Start Test"));

    expect(appHookTestState.testHookState.startTest).toHaveBeenCalledTimes(1);
    openWorkflowStep("Run");
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

    fireEvent.click(getRunAction("Smoke Test"));

    expect(getRunAction("Smoke testing...")).toBeDisabled();
    expect(getRunAction("Start Test")).toBeDisabled();

    openWorkflowStep("Configure");
    applyCurlSnippet(CHANGED_BASE_URL_CURL_SNIPPET);

    expect(getRunAction("Smoke testing...")).toBeDisabled();
    expect(getRunAction("Start Test")).toBeDisabled();

    await act(async () => {
      smokeRequest.resolve(createSoapSmokeResponse());
      await smokeRequest.promise;
    });

    expect(screen.queryByText(SOAP_RESPONSE_PREVIEW)).not.toBeInTheDocument();
    expect(getRunAction("Smoke Test")).toBeEnabled();
  });

  it("keeps smoke test results visible when only load settings change", async () => {
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => createSoapSmokeResponse()),
    });

    renderApp(api);

    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);
    fireEvent.click(getRunAction("Smoke Test"));

    await flushMicrotasks();

    expect(screen.getByText(SOAP_RESPONSE_PREVIEW)).toBeInTheDocument();

    fireEvent.change(getConfigureField("Virtual users"), {
      target: {
        value: "25",
      },
    });
    fireEvent.change(getConfigureField("Duration"), {
      target: {
        value: "2m",
      },
    });

    openWorkflowStep("Run");
    expect(screen.getByText(SOAP_RESPONSE_PREVIEW)).toBeInTheDocument();
  });

  it("clears stale smoke test results when smoke-request inputs change", async () => {
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => createSoapSmokeResponse()),
    });

    renderApp(api);

    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);

    fireEvent.click(getRunAction("Smoke Test"));

    await flushMicrotasks();

    expect(screen.getByText(SOAP_RESPONSE_PREVIEW)).toBeInTheDocument();

    applyCurlSnippet(CHANGED_BASE_URL_CURL_SNIPPET);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    openWorkflowStep("Run");
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

    fireEvent.click(getRunAction("Smoke Test"));

    applyCurlSnippet(CHANGED_BASE_URL_CURL_SNIPPET);

    await act(async () => {
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

    fireEvent.click(getRunAction("Smoke Test"));

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

    fireEvent.click(getRunAction("Smoke Test"));

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

  it("replaces existing request details when a later cURL command omits them", () => {
    renderApp(createApiMock());

    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);

    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "https://api.example.com",
    );

    applyCurlSnippet(TOKEN_ONLY_CURL_SNIPPET);

    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "",
    );
    expect(
      (screen.getByLabelText("Bearer token / JWT") as HTMLInputElement).value,
    ).toBe("token-only");
  });

  it("replaces cURL-applied request headers instead of merging stale headers", () => {
    renderApp(createApiMock());

    applyCurlSnippet(FIRST_HEADER_CURL_SNIPPET);

    expect(screen.getByDisplayValue("X-Trace")).toBeInTheDocument();
    expect(screen.getByDisplayValue("first")).toBeInTheDocument();

    applyCurlSnippet(SECOND_HEADER_CURL_SNIPPET);

    expect(screen.queryByDisplayValue("X-Trace")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("first")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("X-Run")).toBeInTheDocument();
    expect(screen.getByDisplayValue("second")).toBeInTheDocument();
  });

  it("clears a cURL-applied request body override when the next cURL has no body", async () => {
    const api = createApiMock();
    renderApp(api);

    applyCurlSnippet(POSTMAN_REQUEST_DETAILS_CURL_SNIPPET);

    expect(screen.getByText("Request body override")).toBeInTheDocument();

    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);

    expect(
      screen.queryByText("Request body override"),
    ).not.toBeInTheDocument();

    await advanceValidationTimer();

    const validationCalls = vi.mocked(api.validateTestConfiguration).mock
      .calls as Array<[{ options: K6Options }]>;
    const validationOptions =
      validationCalls[validationCalls.length - 1]?.[0].options;
    expect(validationOptions).not.toHaveProperty("requestBodyOverride");
    expect(validationOptions?.requestHeaders).toEqual({});
  });

  it("keeps empty result export and reset actions disabled until they are actionable", () => {
    appHookTestState.importHookState = createImportHookState(null);

    renderApp(createApiMock());

    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(
      within(getLatestResultCard()).getByRole("button", {
        name: "Export Latest Report",
      }),
    ).toBeDisabled();
    expect(
      within(getLatestResultCard()).getByText(
        "Run a test before exporting the retained k6 report.",
      ),
    ).toBeInTheDocument();
  });

  it("disables collection replacement controls while a load test is active", () => {
    appHookTestState.testHookState.state = {
      ...appHookTestState.testHookState.state,
      status: "running",
      isRunning: true,
    };

    renderApp(createApiMock());

    openWorkflowStep("Source");
    const chooseButton = screen.getByRole("button", {
      name: "Choose Postman Collection",
    });
    const resetButton = screen.getByRole("button", { name: "Reset" });
    expect(chooseButton).toBeDisabled();
    expect(resetButton).toBeDisabled();

    fireEvent.click(chooseButton);
    fireEvent.click(resetButton);

    expect(
      appHookTestState.importHookState.selectAndImport,
    ).not.toHaveBeenCalled();
    expect(appHookTestState.importHookState.reset).not.toHaveBeenCalled();
  });

  it("prompts for a report destination from the latest result card before exporting", async () => {
    const longSavePath =
      "/tmp/loadrift/reports/releases/very-long-directory-name-without-natural-breaks/loadrift-report-api-example-com-20260325-151332.html";
    const api = createApiMock({
      selectAndExportReport: vi.fn(async () => ({ savePath: longSavePath })),
    });

    appHookTestState.testHookState.state = {
      ...appHookTestState.testHookState.state,
      status: "completed",
      result: createCompletedResult(),
    };

    renderApp(api);

    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);

    const latestResultCard = getLatestResultCard();
    const liveRunMonitor = getLiveRunMonitor();
    const exportButton = within(latestResultCard).getByRole("button", {
      name: "Export Latest Report",
    });

    expect(
      within(liveRunMonitor).queryByRole("button", {
        name: "Export Latest Report",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(exportButton);

    await act(async () => {
      await Promise.resolve();
    });

    const successMessage = `Report saved to ${longSavePath}.`;

    expect(api.selectAndExportReport).toHaveBeenCalledTimes(1);
    expect(api.selectAndExportReport).toHaveBeenCalledWith({
      defaultPath: "loadrift-report-api-example-com-20260325-151332.html",
    });
    expect(
      within(latestResultCard).getByText(
        "Exports the latest retained k6 report.",
      ),
    ).toBeInTheDocument();
    const notice = within(latestResultCard).getByRole("status");
    expect(notice).toHaveTextContent(successMessage);
    expect(notice).toHaveClass("export-notice");
    expect(
      within(liveRunMonitor).queryByText(successMessage),
    ).not.toBeInTheDocument();
  });

  it("keeps result-state export controls and notices in the latest result card", async () => {
    const api = createApiMock({
      selectAndExportReport: vi.fn(async () => ({
        savePath: "/tmp/loadrift-report.html",
      })),
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
      within(liveRunMonitor).queryByRole("button", {
        name: "Export Latest Report",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(exportButton);

    await flushMicrotasks(2);

    const successMessage = "Report saved to /tmp/loadrift-report.html.";
    expect(within(latestResultCard).getByRole("status")).toHaveTextContent(
      successMessage,
    );
    expect(
      within(liveRunMonitor).queryByText(successMessage),
    ).not.toBeInTheDocument();
  });

  it("shows export failures in the latest result card", async () => {
    const api = createApiMock({
      selectAndExportReport: vi.fn(async () => {
        throw new Error("Run a k6 test before exporting a report.");
      }),
    });

    appHookTestState.testHookState.state = {
      ...appHookTestState.testHookState.state,
      status: "completed",
      result: createCompletedResult(),
    };

    renderApp(api);

    const latestResultCard = getLatestResultCard();
    const liveRunMonitor = getLiveRunMonitor();

    expect(
      within(liveRunMonitor).queryByRole("button", {
        name: "Export Latest Report",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(latestResultCard).getByRole("button", {
        name: "Export Latest Report",
      }),
    );

    await flushMicrotasks(2);

    const failureMessage = "Run a k6 test before exporting a report.";
    const notice = within(latestResultCard).getByRole("alert");
    expect(notice).toHaveTextContent(failureMessage);
    expect(notice).toHaveClass("export-notice");
    expect(
      within(liveRunMonitor).queryByText(failureMessage),
    ).not.toBeInTheDocument();
  });
});
