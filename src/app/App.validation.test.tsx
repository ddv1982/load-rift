import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadRiftApi } from "../lib/loadrift/api";
import type { K6Options, SmokeTestResponse } from "../lib/loadrift/types";
import {
  createAppElement,
  createApiMock,
  createImportHookState,
  createTestHookState,
  deferred,
  importedCollection,
  renderApp,
} from "./test-support/appTestUtils";

let importHookState = createImportHookState();
let testHookState = createTestHookState();
const dialogMocks = vi.hoisted(() => ({
  selectReportSavePath: vi.fn(),
}));

vi.mock("../features/import/useCollectionImport", () => ({
  useCollectionImport: () => importHookState,
}));

vi.mock("../features/test/useTestHarness", () => ({
  useTestHarness: () => testHookState,
}));

vi.mock("../lib/tauri/dialog", () => ({
  selectCollectionFile: vi.fn(),
  selectReportSavePath: dialogMocks.selectReportSavePath,
}));

describe("App validation lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T15:13:32Z"));
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    importHookState = createImportHookState();
    testHookState = createTestHookState();
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

    fireEvent.change(screen.getByLabelText("Postman cURL snippet"), {
      target: {
        value:
          "curl --location 'https://api.example.com/entities/alpha' --header 'Authorization: Bearer integration-token'",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Apply Curl" }));

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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    vi.mocked(api.validateTestConfiguration).mockClear();

    fireEvent.change(screen.getByLabelText("Postman cURL snippet"), {
      target: {
        value:
          "curl --location 'https://api.example.com/entities/alpha' --header 'Authorization: Bearer integration-token'",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply Curl" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

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
    fireEvent.change(screen.getByLabelText("Postman cURL snippet"), {
      target: {
        value: "curl --location 'https://api.example.com/entities/alpha'",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply Curl" }));

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

    expect(screen.getAllByText("IDLE")).toHaveLength(3);
    expect(screen.queryByText("PENDING")).not.toBeInTheDocument();
  });

  it("runs a smoke test, disables conflicting actions, and shows the returned SOAP preview", async () => {
    const smokeResponse: SmokeTestResponse = {
      responses: [
        {
          requestId: "request-0",
          requestName: "SOAP login",
          method: "POST",
          url: "https://api.example.com/soap/login",
          statusCode: 200,
          durationMs: 42,
          ok: true,
          contentType: "text/xml; charset=utf-8",
          responseHeaders: {
            "content-type": "text/xml; charset=utf-8",
          },
          bodyPreview: "<Envelope>ok</Envelope>",
          errorMessage: null,
        },
      ],
    };
    const smokeRequest = deferred<SmokeTestResponse>();
    const api = createApiMock({
      smokeTestRequests: vi.fn(() => smokeRequest.promise),
    });

    renderApp(api);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

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
    expect(screen.getByText("POST https://api.example.com/soap/login")).toBeInTheDocument();
    expect(screen.getByText("<Envelope>ok</Envelope>")).toBeInTheDocument();
  });

  it("clears smoke test results when starting a load test", async () => {
    const smokeResponse: SmokeTestResponse = {
      responses: [
        {
          requestId: "request-0",
          requestName: "SOAP login",
          method: "POST",
          url: "https://api.example.com/soap/login",
          statusCode: 200,
          durationMs: 42,
          ok: true,
          contentType: "text/xml; charset=utf-8",
          responseHeaders: {
            "content-type": "text/xml; charset=utf-8",
          },
          bodyPreview: "<Envelope>ok</Envelope>",
          errorMessage: null,
        },
      ],
    };
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => smokeResponse),
    });

    renderApp(api);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    fireEvent.click(screen.getByRole("button", { name: "Smoke Test" }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("<Envelope>ok</Envelope>")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start Test" }));

    expect(testHookState.startTest).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("<Envelope>ok</Envelope>")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Run a smoke test to execute the selected requests once and inspect the response body, headers, and status before starting load.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the harness busy when smoke-test inputs change mid-flight", async () => {
    const smokeRequest = deferred<SmokeTestResponse>();
    const api = createApiMock({
      smokeTestRequests: vi.fn(() => smokeRequest.promise),
    });

    renderApp(api);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    fireEvent.change(screen.getByLabelText("Postman cURL snippet"), {
      target: {
        value: "curl --location 'https://api.example.com/entities/alpha'",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply Curl" }));

    fireEvent.click(screen.getByRole("button", { name: "Smoke Test" }));

    expect(screen.getByRole("button", { name: "Smoking..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start Test" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Postman cURL snippet"), {
      target: {
        value: "curl --location 'https://api.changed.example.com/entities/alpha'",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply Curl" }));

    expect(screen.getByRole("button", { name: "Smoking..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start Test" })).toBeDisabled();

    await act(async () => {
      smokeRequest.resolve({
        responses: [
          {
            requestId: "request-0",
            requestName: "SOAP login",
            method: "POST",
            url: "https://api.example.com/soap/login",
            statusCode: 200,
            durationMs: 42,
            ok: true,
            contentType: "text/xml; charset=utf-8",
            responseHeaders: {
              "content-type": "text/xml; charset=utf-8",
            },
            bodyPreview: "<Envelope>ok</Envelope>",
            errorMessage: null,
          },
        ],
      });
      await smokeRequest.promise;
    });

    expect(screen.queryByText("<Envelope>ok</Envelope>")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Smoke Test" })).toBeEnabled();
  });

  it("keeps smoke test results visible when only load settings change", async () => {
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => ({
        responses: [
          {
            requestId: "request-0",
            requestName: "SOAP login",
            method: "POST",
            url: "https://api.example.com/soap/login",
            statusCode: 200,
            durationMs: 42,
            ok: true,
            contentType: "text/xml; charset=utf-8",
            responseHeaders: {
              "content-type": "text/xml; charset=utf-8",
            },
            bodyPreview: "<Envelope>ok</Envelope>",
            errorMessage: null,
          },
        ],
      })),
    });

    renderApp(api);

    fireEvent.change(screen.getByLabelText("Postman cURL snippet"), {
      target: {
        value: "curl --location 'https://api.example.com/entities/alpha'",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply Curl" }));
    fireEvent.click(screen.getByRole("button", { name: "Smoke Test" }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("<Envelope>ok</Envelope>")).toBeInTheDocument();

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

    expect(screen.getByText("<Envelope>ok</Envelope>")).toBeInTheDocument();
  });

  it("clears stale smoke test results when smoke-request inputs change", async () => {
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => ({
        responses: [
          {
            requestId: "request-0",
            requestName: "SOAP login",
            method: "POST",
            url: "https://api.example.com/soap/login",
            statusCode: 200,
            durationMs: 42,
            ok: true,
            contentType: "text/xml; charset=utf-8",
            responseHeaders: {
              "content-type": "text/xml; charset=utf-8",
            },
            bodyPreview: "<Envelope>ok</Envelope>",
            errorMessage: null,
          },
        ],
      })),
    });

    renderApp(api);

    fireEvent.change(screen.getByLabelText("Postman cURL snippet"), {
      target: {
        value: "curl --location 'https://api.example.com/entities/alpha'",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply Curl" }));

    fireEvent.click(screen.getByRole("button", { name: "Smoke Test" }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("<Envelope>ok</Envelope>")).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Postman cURL snippet"), {
        target: {
          value: "curl --location 'https://api.changed.example.com/entities/alpha'",
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Apply Curl" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("<Envelope>ok</Envelope>")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Run a smoke test to execute the selected requests once and inspect the response body, headers, and status before starting load.",
      ),
    ).toBeInTheDocument();
  });

  it("discards smoke test results when inputs change before the response returns", async () => {
    const smokeRequest = deferred<SmokeTestResponse>();
    const api = createApiMock({
      smokeTestRequests: vi.fn(() => smokeRequest.promise),
    });

    renderApp(api);

    fireEvent.change(screen.getByLabelText("Postman cURL snippet"), {
      target: {
        value: "curl --location 'https://api.example.com/entities/alpha'",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply Curl" }));

    fireEvent.click(screen.getByRole("button", { name: "Smoke Test" }));

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Postman cURL snippet"), {
        target: {
          value: "curl --location 'https://api.changed.example.com/entities/alpha'",
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Apply Curl" }));
      smokeRequest.resolve({
        responses: [
          {
            requestId: "request-0",
            requestName: "SOAP login",
            method: "POST",
            url: "https://api.example.com/soap/login",
            statusCode: 200,
            durationMs: 42,
            ok: true,
            contentType: "text/xml; charset=utf-8",
            responseHeaders: {
              "content-type": "text/xml; charset=utf-8",
            },
            bodyPreview: "<Envelope>ok</Envelope>",
            errorMessage: null,
          },
        ],
      });
      await smokeRequest.promise;
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText("<Envelope>ok</Envelope>")).not.toBeInTheDocument();
  });

  it("clears smoke test results after re-import when collection defaults change", async () => {
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => ({
        responses: [
          {
            requestId: "request-0",
            requestName: "SOAP login",
            method: "POST",
            url: "https://api.example.com/soap/login",
            statusCode: 200,
            durationMs: 42,
            ok: true,
            contentType: "text/xml; charset=utf-8",
            responseHeaders: {
              "content-type": "text/xml; charset=utf-8",
            },
            bodyPreview: "<Envelope>ok</Envelope>",
            errorMessage: null,
          },
        ],
      })),
    });

    importHookState = createImportHookState({
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

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("<Envelope>ok</Envelope>")).toBeInTheDocument();

    importHookState = createImportHookState({
      ...importedCollection,
      runtimeVariables: [
        {
          key: "environment",
          defaultValue: "https://api.changed.example.com",
        },
      ],
    });
    view.rerender(createAppElement(api));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText("<Envelope>ok</Envelope>")).not.toBeInTheDocument();
  });

  it("clears smoke test results after re-import even when the visible summary is unchanged", async () => {
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => ({
        responses: [
          {
            requestId: "request-0",
            requestName: "SOAP login",
            method: "POST",
            url: "https://api.example.com/soap/login",
            statusCode: 200,
            durationMs: 42,
            ok: true,
            contentType: "text/xml; charset=utf-8",
            responseHeaders: {
              "content-type": "text/xml; charset=utf-8",
            },
            bodyPreview: "<Envelope>ok</Envelope>",
            errorMessage: null,
          },
        ],
      })),
    });

    importHookState = createImportHookState({
      ...importedCollection,
      requests: importedCollection.requests.map((request) => ({ ...request })),
      runtimeVariables: importedCollection.runtimeVariables.map((variable) => ({
        ...variable,
      })),
    });

    const view = renderApp(api);

    fireEvent.click(screen.getByRole("button", { name: "Smoke Test" }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("<Envelope>ok</Envelope>")).toBeInTheDocument();

    importHookState = createImportHookState({
      ...importedCollection,
      requests: importedCollection.requests.map((request) => ({ ...request })),
      runtimeVariables: importedCollection.runtimeVariables.map((variable) => ({
        ...variable,
      })),
    });
    view.rerender(createAppElement(api));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText("<Envelope>ok</Envelope>")).not.toBeInTheDocument();
  });

  it("clears the derived base URL when a later snippet does not contain one", () => {
    renderApp(createApiMock());

    fireEvent.change(screen.getByLabelText("Postman cURL snippet"), {
      target: {
        value: "curl --location 'https://api.example.com/entities/alpha'",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply Curl" }));

    expect((screen.getByLabelText("Derived base URL") as HTMLInputElement).value).toBe(
      "https://api.example.com",
    );

    fireEvent.change(screen.getByLabelText("Postman cURL snippet"), {
      target: {
        value: "curl --header 'Authorization: Bearer token-only'",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply Curl" }));

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

    fireEvent.change(screen.getByLabelText("Postman cURL snippet"), {
      target: {
        value: "curl --location 'https://api.example.com/entities/alpha'",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply Curl" }));

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
