import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appHookTestState,
  resetAppTestEnvironment,
} from "./test-support/appTestState";
import {
  anotherCollection,
  createAppElement,
  createApiMock,
  importedCollection,
  renderApp,
  sameNameDifferentCollection,
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

describe("App persistence", () => {
  beforeEach(() => {
    resetAppTestEnvironment();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores the persisted harness tab while safely ignoring legacy pane width state", () => {
    window.localStorage.setItem("loadrift.ui.active-harness-tab", JSON.stringify("variables"));
    window.localStorage.setItem("loadrift.ui.sidebar-width", JSON.stringify(40));

    renderApp(createApiMock());

    expect(screen.getByLabelText("Environment")).toBeInTheDocument();
    expect(screen.getByLabelText("Duration")).not.toBeVisible();
    expect(screen.getByRole("heading", { name: "Configure and launch" })).toBeInTheDocument();
  });

  it("does not restore legacy curl drafts that may contain auth tokens", () => {
    window.sessionStorage.setItem(
      "loadrift.ui.curl-input",
      JSON.stringify(
        "curl --location 'https://api.example.com/entities/alpha' --header 'Authorization: Bearer secret-token'",
      ),
    );

    renderApp(createApiMock());

    expect(screen.getByRole("button", { name: "Choose Postman Collection" })).toBeInTheDocument();
    expect((screen.getByLabelText("Paste Postman cURL") as HTMLTextAreaElement).value).toBe("");
  });

  it("does not restore a manually entered base URL", () => {
    const api = createApiMock();
    const view = renderApp(api);

    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://manual.example.com" },
    });

    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "https://manual.example.com",
    );

    view.unmount();
    renderApp(api);

    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("");
  });

  it("normalizes invalid persisted VU preferences before rendering controls", () => {
    window.localStorage.setItem(
      "loadrift.ui.runner-preferences",
      JSON.stringify({
        vus: 0,
        duration: "3m",
        rampUp: "instant",
        thresholds: {},
      }),
    );

    renderApp(createApiMock());

    const vusInput = screen.getByLabelText("Virtual users");
    expect((vusInput as HTMLInputElement).value).toBe("10");
    expect(vusInput).not.toHaveAttribute("aria-invalid");
    expect(
      screen.queryByText("Virtual users must be a whole number of 1 or more."),
    ).not.toBeInTheDocument();
  });

  it("restores non-sensitive runner preferences without restoring auth values", () => {
    window.localStorage.setItem(
      "loadrift.ui.runner-preferences",
      JSON.stringify({
        vus: 24,
        duration: "3m",
        rampUp: "gradual",
        rampUpTime: "45s",
        thresholds: {
          p95ResponseTime: 950,
          errorRate: 2.5,
        },
      }),
    );

    renderApp(createApiMock());

    expect((screen.getByLabelText("Virtual users") as HTMLInputElement).value).toBe("24");
    expect((screen.getByLabelText("Duration") as HTMLInputElement).value).toBe("3m");
    expect((screen.getByLabelText("Ramp-up mode") as HTMLSelectElement).value).toBe("gradual");
    expect((screen.getByLabelText("Ramp-up time") as HTMLInputElement).value).toBe("45s");
    expect((screen.getByLabelText("P95 threshold (ms)") as HTMLInputElement).value).toBe("950");
    expect((screen.getByLabelText("Error-rate threshold (%)") as HTMLInputElement).value).toBe(
      "5",
    );
    expect((screen.getByLabelText("Bearer token / JWT") as HTMLInputElement).value).toBe("");
  });

  it("keeps request filters separately for each collection", () => {
    const api = createApiMock();
    const { rerender } = renderApp(api);

    fireEvent.change(screen.getByLabelText("Search requests"), {
      target: { value: "users" },
    });

    appHookTestState.importHookState = {
      ...appHookTestState.importHookState,
      state: {
        ...appHookTestState.importHookState.state,
        collection: anotherCollection,
      },
    };

    rerender(createAppElement(api));

    fireEvent.change(screen.getByLabelText("Search requests"), {
      target: { value: "login" },
    });

    appHookTestState.importHookState = {
      ...appHookTestState.importHookState,
      state: {
        ...appHookTestState.importHookState.state,
        collection: importedCollection,
      },
    };

    rerender(createAppElement(api));

    expect((screen.getByLabelText("Search requests") as HTMLInputElement).value).toBe("users");
  });

  it("separates request filters for different collections with the same name", () => {
    const api = createApiMock();
    const { rerender } = renderApp(api);

    fireEvent.change(screen.getByLabelText("Search requests"), {
      target: { value: "users" },
    });

    appHookTestState.importHookState = {
      ...appHookTestState.importHookState,
      state: {
        ...appHookTestState.importHookState.state,
        collection: sameNameDifferentCollection,
      },
    };

    rerender(createAppElement(api));

    expect((screen.getByLabelText("Search requests") as HTMLInputElement).value).toBe("");

    fireEvent.change(screen.getByLabelText("Search requests"), {
      target: { value: "login" },
    });

    appHookTestState.importHookState = {
      ...appHookTestState.importHookState,
      state: {
        ...appHookTestState.importHookState.state,
        collection: importedCollection,
      },
    };

    rerender(createAppElement(api));

    expect((screen.getByLabelText("Search requests") as HTMLInputElement).value).toBe("users");
  });

  it("ignores ambiguous legacy single-record collection filters", () => {
    window.localStorage.setItem(
      "loadrift.ui.collection-filters",
      JSON.stringify({
        collectionName: "Fixture Collection",
        methodFilter: "GET",
        searchQuery: "users",
      }),
    );

    renderApp(createApiMock());

    expect((screen.getByLabelText("Search requests") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Method") as HTMLSelectElement).value).toBe("all");
  });

  it("keeps working when storage access is blocked", () => {
    const localStorageGetter = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    const sessionStorageGetter = vi
      .spyOn(window, "sessionStorage", "get")
      .mockImplementation(() => {
        throw new DOMException("Blocked", "SecurityError");
      });

    expect(() => renderApp(createApiMock())).not.toThrow();
    expect(screen.getByText("Load Rift")).toBeInTheDocument();

    localStorageGetter.mockRestore();
    sessionStorageGetter.mockRestore();
  });
});
