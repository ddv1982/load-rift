import { act, fireEvent, screen } from "@testing-library/react";
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

    const sourceTab = screen.getByRole("tab", { name: /Source/ });
    const configureTab = screen.getByRole("tab", { name: /Configure/ });
    const runTab = screen.getByRole("tab", { name: /Run/ });

    expect(sourceTab).toHaveAttribute("aria-selected", "false");
    expect(configureTab).toHaveAttribute("aria-selected", "true");
    expect(runTab).toHaveAttribute("aria-selected", "false");
    for (const tab of [sourceTab, configureTab, runTab]) {
      expect(document.getElementById(tab.getAttribute("aria-controls") ?? "")).not.toBeNull();
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

    const chooseButton = screen.getByRole("button", { name: "Choose Postman Collection" });
    chooseButton.focus();
    expect(chooseButton).toHaveFocus();

    appHookTestState.importHookState = createImportHookState(importedCollection);
    rerender(createAppElement(api));

    const configureTab = screen.getByRole("tab", { name: /Configure/ });
    expect(configureTab).toHaveAttribute("aria-selected", "true");
    expect(configureTab).toHaveFocus();
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

  it("announces successful configuration validation as a polite status", async () => {
    renderApp(createApiMock());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    const validationStatus = screen.getByRole("status");
    expect(validationStatus).toHaveTextContent("Configuration Check");
    expect(validationStatus).toHaveTextContent("Configuration looks ready to run.");
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
    expect(validationAlert).toHaveTextContent("Set a base URL before starting.");
    expect(validationAlert).toHaveAttribute("aria-live", "assertive");
    expect(validationAlert).toHaveAttribute("aria-atomic", "true");
  });
});
