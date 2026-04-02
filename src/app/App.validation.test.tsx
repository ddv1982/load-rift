import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadRiftApi } from "../lib/loadrift/api";
import type { K6Options, SmokeTestResponse } from "../lib/loadrift/types";
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
  fireEvent.change(screen.getByLabelText("Postman cURL snippet"), {
    target: {
      value: snippet,
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply Curl" }));
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

  it("applies base URL and bearer token from a pasted curl command", () => {
    renderApp(createApiMock());

    applyCurlSnippet(DEFAULT_CURL_SNIPPET);

    expect((screen.getByLabelText("Derived base URL") as HTMLInputElement).value).toBe(
      "https://api.example.com",
    );
    expect((screen.getByLabelText("Bearer token") as HTMLInputElement).value).toBe(
      "integration-token",
    );
    expect(
      screen.getByText(
        "Applied base URL https://api.example.com and bearer token from the pasted Postman cURL snippet.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Variables" }));
    expect((screen.getByLabelText("Environment") as HTMLInputElement).value).toBe(
      "https://api.example.com",
    );
  });

  it("uses the derived base URL for host-style variables without persisting mirrored overrides", async () => {
    const api = createApiMock();

    renderApp(api);

    await advanceValidationTimer();
    vi.mocked(api.validateTestConfiguration).mockClear();

    applyCurlSnippet(DEFAULT_CURL_SNIPPET);

    await advanceValidationTimer();

    expect((screen.getByLabelText("Derived base URL") as HTMLInputElement).value).toBe(
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
    expect((screen.getByLabelText("Derived base URL") as HTMLInputElement).value).toBe(
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

    expect(screen.getAllByText("IDLE")).toHaveLength(4);
    expect(screen.queryByText("PENDING")).not.toBeInTheDocument();
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

  it("clears the derived base URL when a later snippet does not contain one", () => {
    renderApp(createApiMock());

    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);

    expect((screen.getByLabelText("Derived base URL") as HTMLInputElement).value).toBe(
      "https://api.example.com",
    );

    applyCurlSnippet(TOKEN_ONLY_CURL_SNIPPET);

    expect((screen.getByLabelText("Derived base URL") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Bearer token") as HTMLInputElement).value).toBe(
      "token-only",
    );
  });

  it("prompts for a report destination before exporting", async () => {
    dialogMocks.selectReportSavePath.mockResolvedValue("/tmp/loadrift-report.html");
    const api = createApiMock({
      exportReport: vi.fn(async () => undefined),
    });

    renderApp(api);

    applyCurlSnippet(BASE_URL_ONLY_CURL_SNIPPET);

    fireEvent.click(screen.getByRole("button", { name: "Export Latest Report" }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(dialogMocks.selectReportSavePath).toHaveBeenCalledTimes(1);
    expect(dialogMocks.selectReportSavePath).toHaveBeenCalledWith(
      "loadrift-report-api-example-com-20260325-151332.html",
    );
    expect(api.exportReport).toHaveBeenCalledWith({
      savePath: "/tmp/loadrift-report.html",
    });
  });
});
