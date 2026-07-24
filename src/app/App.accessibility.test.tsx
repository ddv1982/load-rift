import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appHookTestState,
  resetAppTestEnvironment,
} from "./test-support/appTestState";
import {
  createAppElement,
  createApiMock,
  createImportHookState,
  importedCollection,
  renderApp,
} from "./test-support/appTestUtils";

vi.mock("../features/import/useCollectionImport", () => ({
  useCollectionImport: () => appHookTestState.importHookState,
}));

vi.mock("../features/test/useTestHarness", () => ({
  useTestHarness: () => appHookTestState.testHookState,
}));

vi.mock("../features/test/useSmokeTest", () => ({
  useSmokeTest: () => appHookTestState.smokeHookState,
}));

describe("App accessibility", () => {
  beforeEach(() => {
    resetAppTestEnvironment();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes segmented controls as keyboard-navigable tabs", () => {
    renderApp(createApiMock());

    const controlsTab = screen.getByRole("tab", { name: "Controls" });
    const variablesTab = screen.getByRole("tab", { name: "Variables" });

    expect(controlsTab).toHaveAttribute("aria-selected", "true");
    expect(variablesTab).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(controlsTab, { key: "ArrowRight" });
    expect(variablesTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("tabpanel", { name: "Variables" }),
    ).toBeInTheDocument();
    const controlsPanel = document.getElementById(
      controlsTab.getAttribute("aria-controls") ?? "",
    );
    expect(controlsPanel).not.toBeVisible();
  });

  it("surfaces the redesigned workflow stages with explicit headings", () => {
    renderApp(createApiMock());

    const sourceTab = screen.getByRole("tab", { name: /Source/ });
    const configureTab = screen.getByRole("tab", { name: /Configure/ });
    const runTab = screen.getByRole("tab", { name: /Run/ });

    expect(sourceTab).toHaveAttribute("aria-selected", "false");
    expect(configureTab).toHaveAttribute("aria-selected", "true");
    expect(runTab).toHaveAttribute("aria-selected", "false");
    for (const tab of [sourceTab, configureTab, runTab]) {
      expect(
        document.getElementById(tab.getAttribute("aria-controls") ?? ""),
      ).not.toBeNull();
    }

    fireEvent.click(sourceTab);
    expect(
      screen.getByRole("heading", { name: "Import a collection" }),
    ).toBeInTheDocument();

    fireEvent.click(configureTab);
    expect(
      screen.getByRole("heading", { name: "Configure the run" }),
    ).toBeInTheDocument();

    fireEvent.click(runTab);
    expect(
      screen.getByRole("heading", { name: "Validate, launch, and review" }),
    ).toBeInTheDocument();
  });

  it("supports keyboard navigation across workflow tabs", () => {
    renderApp(createApiMock());

    const sourceTab = screen.getByRole("tab", { name: /Source/ });
    const configureTab = screen.getByRole("tab", { name: /Configure/ });
    const runTab = screen.getByRole("tab", { name: /Run/ });

    fireEvent.keyDown(configureTab, { key: "ArrowRight" });
    expect(runTab).toHaveAttribute("aria-selected", "true");
    expect(runTab).toHaveFocus();

    fireEvent.keyDown(runTab, { key: "Home" });
    expect(sourceTab).toHaveAttribute("aria-selected", "true");
    expect(sourceTab).toHaveFocus();

    fireEvent.keyDown(sourceTab, { key: "End" });
    expect(runTab).toHaveAttribute("aria-selected", "true");
    expect(runTab).toHaveFocus();
  });

  it("moves focus to Configure when Source auto-advances after import", () => {
    appHookTestState.importHookState = createImportHookState(null);
    const api = createApiMock();
    const { rerender } = renderApp(api);

    const chooseButton = screen.getByRole("button", {
      name: "Choose Postman Collection",
    });
    chooseButton.focus();
    expect(chooseButton).toHaveFocus();

    appHookTestState.importHookState =
      createImportHookState(importedCollection);
    rerender(createAppElement(api));

    const configureTab = screen.getByRole("tab", { name: /Configure/ });
    expect(configureTab).toHaveAttribute("aria-selected", "true");
    expect(configureTab).toHaveFocus();
  });

  it("links VU validation feedback to the VU input", () => {
    renderApp(createApiMock());

    const vusInput = screen.getByLabelText("Virtual users");
    fireEvent.change(vusInput, { target: { value: "0" } });

    const error = screen.getByText(
      "Virtual users must be a whole number of 1 or more.",
    );
    expect(vusInput).toHaveAttribute("aria-describedby", error.id);
    expect(vusInput).toHaveAttribute("aria-invalid", "true");
  });

  it("links advanced JSON feedback to the textarea", () => {
    renderApp(createApiMock());

    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    const advancedJsonInput = screen.getByLabelText("Advanced options JSON");
    fireEvent.change(advancedJsonInput, { target: { value: "{bad" } });

    const feedback = screen.getByText(/Invalid JSON:/);
    expect(advancedJsonInput).toHaveAttribute("aria-describedby", feedback.id);
    expect(advancedJsonInput).toHaveAttribute("aria-invalid", "true");
  });

  it("announces successful configuration validation as a polite status", async () => {
    renderApp(createApiMock());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    const validationStatus = screen.getByRole("status");
    expect(validationStatus).toHaveTextContent("Configuration Check");
    expect(validationStatus).toHaveTextContent(
      "Configuration looks ready to run.",
    );
    expect(validationStatus).toHaveAttribute("aria-live", "polite");
    expect(validationStatus).toHaveAttribute("aria-atomic", "true");
  });

  it("announces failed configuration validation as an alert", async () => {
    renderApp(
      createApiMock({
        validateTestConfiguration: vi.fn(() =>
          Promise.resolve({
            ready: false,
            message: "Set a base URL before starting.",
          }),
        ),
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    const validationAlert = screen.getByRole("alert");
    expect(validationAlert).toHaveTextContent("Configuration Check");
    expect(validationAlert).toHaveTextContent(
      "Set a base URL before starting.",
    );
    expect(validationAlert).toHaveAttribute("aria-live", "assertive");
    expect(validationAlert).toHaveAttribute("aria-atomic", "true");
  });

  it("announces collection import progress and outcomes without treating idle content as an alert", () => {
    appHookTestState.importHookState = createImportHookState(null);
    const api = createApiMock();
    const { rerender } = renderApp(api);
    const sourcePanel = screen
      .getByRole("heading", { name: "Import a collection" })
      .closest("section");

    expect(sourcePanel).not.toBeNull();
    expect(within(sourcePanel!).queryByRole("status")).not.toBeInTheDocument();
    expect(within(sourcePanel!).queryByRole("alert")).not.toBeInTheDocument();

    appHookTestState.importHookState = {
      ...createImportHookState(null),
      state: {
        ...createImportHookState(null).state,
        isLoading: true,
      },
    };
    rerender(createAppElement(api));

    const loadingStatus = within(sourcePanel!).getByRole("status");
    expect(loadingStatus).toHaveTextContent("Importing collection");
    expect(loadingStatus).toHaveAttribute("aria-live", "polite");
    expect(loadingStatus).toHaveAttribute("aria-atomic", "true");

    appHookTestState.importHookState = createImportHookState(null);
    (
      appHookTestState.importHookState.state as {
        error: string | null;
      }
    ).error = "The selected collection could not be imported.";
    rerender(createAppElement(api));

    const importAlert = within(sourcePanel!).getByRole("alert");
    expect(importAlert).toHaveTextContent(
      "The selected collection could not be imported.",
    );
    expect(importAlert).toHaveAttribute("aria-live", "assertive");
    expect(importAlert).toHaveAttribute("aria-atomic", "true");
    expect(within(sourcePanel!).queryByRole("status")).not.toBeInTheDocument();

    appHookTestState.importHookState =
      createImportHookState(importedCollection);
    rerender(createAppElement(api));
    fireEvent.click(screen.getByRole("tab", { name: /Source/ }));

    const loadedSourcePanel = screen
      .getByRole("heading", { name: "Import a collection" })
      .closest("section");
    const successStatus = within(loadedSourcePanel!).getByRole("status");
    expect(successStatus).toHaveTextContent("Collection loaded");
    expect(successStatus).toHaveAttribute("aria-live", "polite");
    expect(successStatus).toHaveAttribute("aria-atomic", "true");
  });

  it("does not expose idle run and smoke copy as a live outcome", () => {
    renderApp(createApiMock());
    fireEvent.click(screen.getByRole("tab", { name: /Run/ }));
    const runPanel = screen
      .getByRole("heading", { name: "Validate, launch, and review" })
      .closest("section");

    expect(runPanel).not.toBeNull();
    expect(within(runPanel!).queryByRole("status")).not.toBeInTheDocument();
    expect(within(runPanel!).queryByRole("alert")).not.toBeInTheDocument();
    expect(runPanel!.querySelectorAll("[aria-live]")).toHaveLength(0);
  });

  it("announces smoke running, success, failed responses, and command errors in a single outcome region", () => {
    appHookTestState.smokeHookState = {
      ...appHookTestState.smokeHookState,
      state: {
        isRunning: true,
        result: null,
        error: null,
      },
    };
    const api = createApiMock();
    const { rerender } = renderApp(api);
    fireEvent.click(screen.getByRole("tab", { name: /Run/ }));
    const smokeCard = screen.getByText("Running").closest("section");

    expect(smokeCard).not.toBeNull();
    const runningStatus = within(smokeCard!).getByRole("status", {
      name: "Smoke test running.",
    });
    expect(runningStatus).toHaveTextContent("Running");
    expect(runningStatus).toHaveAttribute("aria-live", "polite");
    expect(runningStatus).toHaveAttribute("aria-atomic", "true");
    expect(smokeCard!.querySelectorAll("[aria-live]")).toHaveLength(1);

    const successfulResponse = {
      requestId: "request-0",
      requestName: "GET users",
      method: "GET",
      url: "https://api.example.com/users",
      statusCode: 200,
      durationMs: 12,
      ok: true,
      contentType: "application/json",
      responseHeaders: {},
      bodyPreview: '{"ok":true}',
      errorMessage: null,
    };
    appHookTestState.smokeHookState = {
      ...appHookTestState.smokeHookState,
      state: {
        isRunning: false,
        result: { responses: [successfulResponse] },
        error: null,
      },
    };
    rerender(createAppElement(api));

    const successStatus = within(smokeCard!).getByRole("status", {
      name: "Smoke test completed successfully.",
    });
    expect(successStatus).toHaveTextContent("Captured");
    expect(smokeCard!.querySelector("pre")).not.toHaveAttribute("aria-live");

    appHookTestState.smokeHookState = {
      ...appHookTestState.smokeHookState,
      state: {
        isRunning: false,
        result: {
          responses: [
            {
              ...successfulResponse,
              ok: false,
              statusCode: 500,
              errorMessage: "Unexpected response",
            },
          ],
        },
        error: null,
      },
    };
    rerender(createAppElement(api));

    const failedResultAlert = within(smokeCard!).getByRole("alert", {
      name: "Smoke test completed with failed responses.",
    });
    expect(failedResultAlert).toHaveTextContent("Failed");
    expect(failedResultAlert).toHaveAttribute("aria-live", "assertive");
    expect(failedResultAlert).toHaveAttribute("aria-atomic", "true");

    appHookTestState.smokeHookState.state = {
      isRunning: false,
      result: null,
      error: null,
    };
    (
      appHookTestState.smokeHookState.state as {
        error: string | null;
      }
    ).error = "Smoke command failed to start.";
    rerender(createAppElement(api));

    const commandAlert = within(smokeCard!).getByRole("alert", {
      name: "Smoke test command failed: Smoke command failed to start.",
    });
    expect(commandAlert).toHaveTextContent("Error");
    expect(
      within(smokeCard!).getByText("Smoke command failed to start."),
    ).not.toHaveAttribute("aria-live");
    expect(smokeCard!.querySelectorAll("[aria-live]")).toHaveLength(1);
  });

  it("announces load outcomes without making metrics or raw logs live", () => {
    const resultMetrics = {
      totalRequests: 8,
      failedRequests: 0,
      avgResponseTime: 90,
      p50ResponseTime: 80,
      p95ResponseTime: 120,
      maxResponseTime: 150,
      requestsPerSecond: 4,
    };
    appHookTestState.testHookState.state = {
      ...appHookTestState.testHookState.state,
      status: "running",
      isRunning: true,
      output: "runner output line 1",
    };
    const api = createApiMock();
    const { rerender } = renderApp(api);

    expect(
      screen.queryByRole("status", { name: "Load test running." }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Run/ }));
    const runPanel = screen
      .getByRole("heading", { name: "Validate, launch, and review" })
      .closest("section");

    expect(runPanel).not.toBeNull();
    const runningStatus = within(runPanel!).getByRole("status", {
      name: "Load test running.",
    });
    expect(runningStatus).toHaveAttribute("aria-live", "polite");
    expect(runningStatus).toHaveAttribute("aria-atomic", "true");
    expect(runPanel!.querySelector("pre.event-log")).not.toHaveAttribute(
      "aria-live",
    );
    expect(
      runPanel!.querySelector('[aria-label="Live run metrics overview"]'),
    ).not.toHaveAttribute("aria-live");
    expect(runPanel!.querySelectorAll("[aria-live]")).toHaveLength(1);

    appHookTestState.testHookState.state = {
      ...appHookTestState.testHookState.state,
      metrics: {
        ...appHookTestState.testHookState.state.metrics,
        totalRequests: 500,
      },
      output: "runner output line 1\nrunner output line 2",
    };
    rerender(createAppElement(api));
    expect(runPanel!.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(within(runPanel!).getByRole("status")).toHaveAccessibleName(
      "Load test running.",
    );

    appHookTestState.testHookState.state = {
      ...appHookTestState.testHookState.state,
      status: "completed",
      isRunning: false,
      result: {
        status: "passed",
        metrics: resultMetrics,
        thresholds: [],
      },
    };
    rerender(createAppElement(api));
    expect(
      within(runPanel!).getByRole("status", {
        name: "Load test completed successfully.",
      }),
    ).toHaveAttribute("aria-live", "polite");

    appHookTestState.testHookState.state = {
      ...appHookTestState.testHookState.state,
      result: {
        status: "warning",
        metrics: { ...resultMetrics, failedRequests: 1 },
        thresholds: [],
      },
    };
    rerender(createAppElement(api));
    expect(
      within(runPanel!).getByRole("status", {
        name: "Load test completed with warnings.",
      }),
    ).toHaveAttribute("aria-atomic", "true");

    appHookTestState.testHookState.state = {
      ...appHookTestState.testHookState.state,
      result: {
        status: "failed",
        metrics: { ...resultMetrics, failedRequests: 8 },
        thresholds: [],
      },
    };
    rerender(createAppElement(api));
    const failedResultAlert = within(runPanel!).getByRole("alert", {
      name: "Load test completed with a failed result.",
    });
    expect(failedResultAlert).toHaveAttribute("aria-live", "assertive");
    expect(failedResultAlert).toHaveAttribute("aria-atomic", "true");

    appHookTestState.testHookState.state = {
      ...appHookTestState.testHookState.state,
      status: "failed",
      error: "k6 process exited unexpectedly.",
      result: {
        status: "warning",
        metrics: { ...resultMetrics, failedRequests: 1 },
        thresholds: [],
      },
    };
    rerender(createAppElement(api));
    expect(
      within(runPanel!).getByRole("alert", {
        name: "Load test failed: k6 process exited unexpectedly.",
      }),
    ).toHaveAttribute("aria-live", "assertive");
    expect(runPanel!.querySelectorAll("[aria-live]")).toHaveLength(1);
  });
});
