import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appHookTestState,
  resetAppTestEnvironment,
} from "./test-support/appTestState";
import {
  createApiMock,
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

vi.mock("../lib/tauri/dialog", () => ({
  selectCollectionFile: vi.fn(),
  selectReportSavePath: vi.fn(),
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
    expect(screen.getByRole("tabpanel", { name: "Variables" })).toBeInTheDocument();
    const controlsPanel = document.getElementById(
      controlsTab.getAttribute("aria-controls") ?? "",
    );
    expect(controlsPanel).not.toBeVisible();
  });

  it("surfaces the redesigned workflow stages with explicit headings", () => {
    renderApp(createApiMock());

    expect(
      screen.getByRole("heading", { name: "Import a collection" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Configure and launch" }),
    ).toBeInTheDocument();
  });
});
