import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appHookTestState,
  resetAppTestEnvironment,
} from "./test-support/appTestState";
import {
  anotherCollection,
  createApiMock,
  createImportHookState,
  orderedCollection,
  renderApp,
  separatorFolderCollection,
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

vi.mock("../lib/tauri/dialog", () => ({
  selectCollectionFile: vi.fn(),
  selectReportSavePath: vi.fn(),
}));

function openWorkflowStep(step: "Source" | "Configure" | "Run") {
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(step) }));
}

describe("App collection summary", () => {
  beforeEach(() => {
    resetAppTestEnvironment();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses and expands folder rows in the collection summary", () => {
    appHookTestState.importHookState = createImportHookState(anotherCollection);

    renderApp(createApiMock());
    openWorkflowStep("Source");

    expect(screen.getByText("POST login")).toBeInTheDocument();
    expect(screen.getByText("GET account")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse folder Auth" }));

    expect(screen.queryByText("POST login")).not.toBeInTheDocument();
    expect(screen.queryByText("GET account")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand folder Auth" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand folder Auth" }));

    expect(screen.getByText("POST login")).toBeInTheDocument();
    expect(screen.getByText("GET account")).toBeInTheDocument();
  });

  it("preserves imported request order when rendering folder rows", () => {
    appHookTestState.importHookState = createImportHookState(orderedCollection);

    renderApp(createApiMock());
    openWorkflowStep("Source");

    const rowTexts = screen
      .getAllByRole("listitem")
      .map((item) => item.textContent?.replace(/\s+/g, " ").trim() ?? "");

    const rootOverviewIndex = rowTexts.findIndex((text) => text.includes("Root overview"));
    const authFolderIndex = rowTexts.findIndex((text) => text.includes("Auth"));
    const postLoginIndex = rowTexts.findIndex((text) => text.includes("POST login"));
    const getAccountIndex = rowTexts.findIndex((text) => text.includes("GET account"));
    const rootTeardownIndex = rowTexts.findIndex((text) => text.includes("Root teardown"));

    expect(rootOverviewIndex).toBeGreaterThanOrEqual(0);
    expect(authFolderIndex).toBeGreaterThan(rootOverviewIndex);
    expect(postLoginIndex).toBeGreaterThan(authFolderIndex);
    expect(getAccountIndex).toBeGreaterThan(postLoginIndex);
    expect(rootTeardownIndex).toBeGreaterThan(getAccountIndex);
  });

  it("keeps folders with separator characters isolated from nested folder paths", () => {
    appHookTestState.importHookState = createImportHookState(separatorFolderCollection);

    renderApp(createApiMock());
    openWorkflowStep("Source");

    expect(screen.getByText("Slash folder request")).toBeInTheDocument();
    expect(screen.getByText("Nested folder request")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse folder A / B" }));

    expect(screen.queryByText("Slash folder request")).not.toBeInTheDocument();
    expect(screen.getByText("Nested folder request")).toBeInTheDocument();
  });

  it("limits initial rendering for large request lists and reveals more on demand", () => {
    appHookTestState.importHookState = createImportHookState({
      name: "Large Fixture Collection",
      requestCount: 300,
      folderCount: 0,
      requests: Array.from({ length: 300 }, (_, index) => ({
        id: `request-${index}`,
        name: `Request ${index}`,
        method: "GET",
        url: `{{environment}}/items/${index}`,
        folderPath: [],
      })),
      runtimeVariables: [{ key: "environment" }],
    });

    renderApp(createApiMock());
    openWorkflowStep("Source");

    expect(screen.getByText("Request 0")).toBeInTheDocument();
    expect(screen.getByText("Request 249")).toBeInTheDocument();
    expect(screen.queryByText("Request 299")).not.toBeInTheDocument();
    expect(screen.getByText("50 additional rows hidden")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(screen.getByText("Request 299")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("clears active request filters and restores hidden rows", async () => {
    appHookTestState.importHookState = createImportHookState(anotherCollection);

    renderApp(createApiMock());
    openWorkflowStep("Source");

    fireEvent.change(screen.getByLabelText("Search requests"), {
      target: { value: "login" },
    });
    fireEvent.change(screen.getByLabelText("Method"), {
      target: { value: "POST" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(screen.getByText("POST login")).toBeInTheDocument();
    expect(screen.queryByText("GET account")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect((screen.getByLabelText("Search requests") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Method") as HTMLSelectElement).value).toBe("all");
    expect(screen.getByText("POST login")).toBeInTheDocument();
    expect(screen.getByText("GET account")).toBeInTheDocument();
  });

  it("offers clear filters from the empty filtered state", async () => {
    appHookTestState.importHookState = createImportHookState(anotherCollection);

    renderApp(createApiMock());
    openWorkflowStep("Source");

    fireEvent.change(screen.getByLabelText("Search requests"), {
      target: { value: "does-not-exist" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(screen.getByText("No requests match the current filters.")).toBeInTheDocument();
    expect(screen.getByText("Clear filters to show all imported requests.")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Clear filters and show all requests" }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(screen.getByText("POST login")).toBeInTheDocument();
    expect(screen.getByText("GET account")).toBeInTheDocument();
  });

  it("selects only visible requests when using filtered bulk selection", async () => {
    appHookTestState.importHookState = createImportHookState(anotherCollection);

    renderApp(createApiMock());
    openWorkflowStep("Source");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    fireEvent.change(screen.getByLabelText("Method"), {
      target: { value: "GET" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    fireEvent.click(screen.getByRole("button", { name: "Select visible" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    openWorkflowStep("Run");
    fireEvent.click(screen.getByRole("button", { name: "Start Test" }));

    expect(appHookTestState.testHookState.startTest).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedRequestIds: ["request-1"],
      }),
    );
  });

  it("sends weighted request settings when weighted mix is configured", async () => {
    appHookTestState.importHookState = createImportHookState(anotherCollection);

    renderApp(createApiMock());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    fireEvent.click(screen.getByRole("tab", { name: "Controls" }));
    fireEvent.change(screen.getByLabelText("Traffic mode"), {
      target: { value: "weighted" },
    });

    openWorkflowStep("Source");
    expect(screen.getByText(/Weighted mix uses selected requests/)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    fireEvent.change(screen.getByLabelText("Weight for POST login"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText("Weight for GET account"), {
      target: { value: "3" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    openWorkflowStep("Run");
    fireEvent.click(screen.getByRole("button", { name: "Start Test" }));

    expect(appHookTestState.testHookState.startTest).toHaveBeenCalledWith(
      expect.objectContaining({
        trafficMode: "weighted",
        requestWeights: {
          "request-0": 0,
          "request-1": 3,
        },
      }),
    );
  });
});
