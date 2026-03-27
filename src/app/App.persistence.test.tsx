import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  anotherCollection,
  createAppElement,
  createApiMock,
  createImportHookState,
  createSmokeHookState,
  createTestHookState,
  importedCollection,
  renderApp,
  sameNameDifferentCollection,
} from "./test-support/appTestUtils";

let importHookState = createImportHookState();
let testHookState = createTestHookState();
let smokeHookState = createSmokeHookState();

vi.mock("../features/import/useCollectionImport", () => ({
  useCollectionImport: () => importHookState,
}));

vi.mock("../features/test/useTestHarness", () => ({
  useTestHarness: () => testHookState,
}));

vi.mock("../features/test/useSmokeTest", () => ({
  useSmokeTest: () => smokeHookState,
}));

vi.mock("../lib/tauri/dialog", () => ({
  selectCollectionFile: vi.fn(),
  selectReportSavePath: vi.fn(),
}));

describe("App persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T15:13:32Z"));
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    importHookState = createImportHookState();
    testHookState = createTestHookState();
    smokeHookState = createSmokeHookState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores the persisted harness tab and pane width", () => {
    window.localStorage.setItem("loadrift.ui.active-harness-tab", JSON.stringify("variables"));
    window.localStorage.setItem("loadrift.ui.sidebar-width", JSON.stringify(40));

    renderApp(createApiMock());

    expect(screen.getByLabelText("Environment")).toBeInTheDocument();
    expect(screen.getByLabelText("Duration")).not.toBeVisible();
    expect(document.querySelector(".workspace-shell")).toHaveStyle("--sidebar-width: 40%");
  });

  it("restores the current curl draft", () => {
    window.sessionStorage.setItem(
      "loadrift.ui.curl-input",
      JSON.stringify("curl --location 'https://api.example.com/entities/alpha'"),
    );

    renderApp(createApiMock());

    expect(screen.getByRole("button", { name: "Choose Postman Collection" })).toBeInTheDocument();
    expect((screen.getByLabelText("Postman cURL snippet") as HTMLTextAreaElement).value).toBe(
      "curl --location 'https://api.example.com/entities/alpha'",
    );
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
      "2.5",
    );
    expect((screen.getByLabelText("Bearer token") as HTMLInputElement).value).toBe("");
  });

  it("keeps request filters separately for each collection", () => {
    const api = createApiMock();
    const { rerender } = renderApp(api);

    fireEvent.change(screen.getByLabelText("Search requests"), {
      target: { value: "users" },
    });

    importHookState = {
      ...importHookState,
      state: {
        ...importHookState.state,
        collection: anotherCollection,
      },
    };

    rerender(createAppElement(api));

    fireEvent.change(screen.getByLabelText("Search requests"), {
      target: { value: "login" },
    });

    importHookState = {
      ...importHookState,
      state: {
        ...importHookState.state,
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

    importHookState = {
      ...importHookState,
      state: {
        ...importHookState.state,
        collection: sameNameDifferentCollection,
      },
    };

    rerender(createAppElement(api));

    expect((screen.getByLabelText("Search requests") as HTMLInputElement).value).toBe("");

    fireEvent.change(screen.getByLabelText("Search requests"), {
      target: { value: "login" },
    });

    importHookState = {
      ...importHookState,
      state: {
        ...importHookState.state,
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
