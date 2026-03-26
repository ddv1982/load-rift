import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  anotherCollection,
  createApiMock,
  createImportHookState,
  createTestHookState,
  orderedCollection,
  renderApp,
  separatorFolderCollection,
} from "./test-support/appTestUtils";

let importHookState = createImportHookState();
let testHookState = createTestHookState();

vi.mock("../features/import/useCollectionImport", () => ({
  useCollectionImport: () => importHookState,
}));

vi.mock("../features/test/useTestHarness", () => ({
  useTestHarness: () => testHookState,
}));

vi.mock("../lib/tauri/dialog", () => ({
  selectCollectionFile: vi.fn(),
  selectReportSavePath: vi.fn(),
}));

describe("App collection summary", () => {
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

  it("collapses and expands folder rows in the collection summary", () => {
    importHookState = createImportHookState(anotherCollection);

    renderApp(createApiMock());

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
    importHookState = createImportHookState(orderedCollection);

    renderApp(createApiMock());

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
    importHookState = createImportHookState(separatorFolderCollection);

    renderApp(createApiMock());

    expect(screen.getByText("Slash folder request")).toBeInTheDocument();
    expect(screen.getByText("Nested folder request")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse folder A / B" }));

    expect(screen.queryByText("Slash folder request")).not.toBeInTheDocument();
    expect(screen.getByText("Nested folder request")).toBeInTheDocument();
  });

  it("selects only visible requests when using filtered bulk selection", async () => {
    importHookState = createImportHookState(anotherCollection);

    renderApp(createApiMock());

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

    fireEvent.click(screen.getByRole("button", { name: "Start Test" }));

    expect(testHookState.startTest).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedRequestIds: ["request-1"],
      }),
    );
  });
});
