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
      screen.getByRole("heading", { name: "Configure the run" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Validate, launch, and review" }),
    ).toBeInTheDocument();
  });

  it("links VU validation feedback to the VU input", () => {
    renderApp(createApiMock());

    const vusInput = screen.getByLabelText("Virtual users");
    fireEvent.change(vusInput, { target: { value: "0" } });

    const error = screen.getByText("Virtual users must be a whole number of 1 or more.");
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
});
