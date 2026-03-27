import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApiMock,
  createImportHookState,
  createTestHookState,
  renderApp,
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

describe("App accessibility", () => {
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

  it("exposes segmented controls as keyboard-navigable tabs", () => {
    renderApp(createApiMock());

    const controlsTab = screen.getByRole("tab", { name: "Controls" });
    const variablesTab = screen.getByRole("tab", { name: "Variables" });

    expect(controlsTab).toHaveAttribute("aria-selected", "true");
    expect(variablesTab).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(controlsTab, { key: "ArrowRight" });
    expect(variablesTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Variables" })).toBeInTheDocument();
    const controlsPanel = document.getElementById(
      controlsTab.getAttribute("aria-controls") ?? "",
    );
    expect(controlsPanel).not.toBeVisible();
  });
});
