import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appHookTestState,
  resetAppTestEnvironment,
} from "./test-support/appTestState";
import {
  anotherCollection,
  createAppElement,
  createApiMock,
  createImportHookState,
  importedCollection,
  renderApp,
  sameNameDifferentCollection,
} from "./test-support/appTestUtils";
import { createCollectionStorageKey } from "./persistence";

vi.mock("../features/import/useCollectionImport", () => ({
  useCollectionImport: () => appHookTestState.importHookState,
}));

vi.mock("../features/test/useTestHarness", () => ({
  useTestHarness: () => appHookTestState.testHookState,
}));

vi.mock("../features/test/useSmokeTest", () => ({
  useSmokeTest: () => appHookTestState.smokeHookState,
}));

function openWorkflowStep(step: "Source" | "Configure" | "Run") {
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(step) }));
}

function expectDefaultCollectionFilters() {
  expect(
    (screen.getByLabelText("Search requests") as HTMLInputElement).value,
  ).toBe("");
  expect((screen.getByLabelText("Method") as HTMLSelectElement).value).toBe(
    "all",
  );
}

describe("App persistence", () => {
  beforeEach(() => {
    resetAppTestEnvironment();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores the persisted harness tab while safely ignoring legacy pane width state", () => {
    window.localStorage.setItem(
      "loadrift.ui.active-harness-tab",
      JSON.stringify("variables"),
    );
    window.localStorage.setItem(
      "loadrift.ui.sidebar-width",
      JSON.stringify(40),
    );

    renderApp(createApiMock());

    expect(screen.getByLabelText("Environment")).toBeInTheDocument();
    expect(screen.getByLabelText("Duration")).not.toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Configure the run" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Run/ }));
    expect(
      screen.getByRole("heading", { name: "Validate, launch, and review" }),
    ).toBeInTheDocument();
  });

  it("does not restore legacy curl drafts that may contain auth tokens", () => {
    window.sessionStorage.setItem(
      "loadrift.ui.curl-input",
      JSON.stringify(
        "curl --location 'https://api.example.com/entities/alpha' --header 'Authorization: Bearer secret-token'",
      ),
    );

    renderApp(createApiMock());

    fireEvent.click(screen.getByRole("tab", { name: /Source/ }));
    expect(
      screen.getByRole("button", { name: "Choose Postman Collection" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Configure/ }));
    expect(
      (screen.getByLabelText("Paste Postman cURL") as HTMLTextAreaElement)
        .value,
    ).toBe("");
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

    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("clears request-scoped runner values and stale run state when the collection changes", async () => {
    const api = createApiMock();
    appHookTestState.testHookState.state = {
      ...appHookTestState.testHookState.state,
      status: "completed",
      result: {
        status: "passed",
        metrics: {
          totalRequests: 10,
          failedRequests: 0,
          avgResponseTime: 100,
          p50ResponseTime: 90,
          p95ResponseTime: 140,
          maxResponseTime: 180,
          requestsPerSecond: 5,
        },
        thresholds: [],
      },
      output: "previous run output",
    };
    appHookTestState.smokeHookState.state = {
      ...appHookTestState.smokeHookState.state,
      result: {
        responses: [],
      },
    };
    const { rerender } = renderApp(api);

    openWorkflowStep("Configure");
    fireEvent.click(screen.getByRole("tab", { name: "Controls" }));
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://api.previous.example.com" },
    });
    fireEvent.change(screen.getByLabelText("Bearer token / JWT"), {
      target: { value: "previous-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Header" }));
    fireEvent.change(screen.getByLabelText("Request header 1 name"), {
      target: { value: "X-Previous" },
    });
    fireEvent.change(screen.getByLabelText("Request header 1 value"), {
      target: { value: "previous" },
    });

    appHookTestState.importHookState = createImportHookState(anotherCollection);
    rerender(createAppElement(api));

    await act(async () => {
      await Promise.resolve();
    });

    openWorkflowStep("Configure");
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "",
    );
    expect(
      (screen.getByLabelText("Bearer token / JWT") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.queryByDisplayValue("X-Previous")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("previous")).not.toBeInTheDocument();
    expect(appHookTestState.testHookState.clearTestState).toHaveBeenCalledTimes(
      1,
    );
    expect(
      appHookTestState.smokeHookState.clearSmokeTest,
    ).toHaveBeenCalledTimes(1);
  });

  it("keeps selected requests and weights on same-collection rerenders", async () => {
    const api = createApiMock();
    appHookTestState.importHookState = createImportHookState(anotherCollection);
    const { rerender } = renderApp(api);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Controls" }));
    fireEvent.change(screen.getByLabelText("Traffic mode"), {
      target: { value: "weighted" },
    });
    openWorkflowStep("Source");
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    fireEvent.click(screen.getByLabelText("Run request GET account"));
    fireEvent.change(screen.getByLabelText("Weight for GET account"), {
      target: { value: "4" },
    });

    appHookTestState.importHookState = createImportHookState({
      ...anotherCollection,
      requests: anotherCollection.requests.map((request) => ({ ...request })),
      runtimeVariables: anotherCollection.runtimeVariables.map((variable) => ({
        ...variable,
      })),
    });
    rerender(createAppElement(api));

    await act(async () => {
      await Promise.resolve();
    });

    openWorkflowStep("Source");
    expect(
      screen.getByLabelText("Run request POST login") as HTMLInputElement,
    ).not.toBeChecked();
    expect(
      screen.getByLabelText("Run request GET account") as HTMLInputElement,
    ).toBeChecked();
    expect(
      (screen.getByLabelText("Weight for GET account") as HTMLInputElement)
        .value,
    ).toBe("4");
    expect(
      appHookTestState.testHookState.clearTestState,
    ).not.toHaveBeenCalled();
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

    expect(
      (screen.getByLabelText("Virtual users") as HTMLInputElement).value,
    ).toBe("24");
    expect((screen.getByLabelText("Duration") as HTMLInputElement).value).toBe(
      "3m",
    );
    expect(
      (screen.getByLabelText("Ramp-up mode") as HTMLSelectElement).value,
    ).toBe("gradual");
    expect(
      (screen.getByLabelText("Ramp-up time") as HTMLInputElement).value,
    ).toBe("45s");
    expect(
      (screen.getByLabelText("P95 threshold (ms)") as HTMLInputElement).value,
    ).toBe("950");
    expect(
      (screen.getByLabelText("Error-rate threshold (%)") as HTMLInputElement)
        .value,
    ).toBe("5");
    expect(
      (screen.getByLabelText("Bearer token / JWT") as HTMLInputElement).value,
    ).toBe("");
  });

  it("keeps request filters separately for each collection", () => {
    const api = createApiMock();
    const { rerender } = renderApp(api);

    fireEvent.click(screen.getByRole("tab", { name: /Source/ }));
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
    fireEvent.click(screen.getByRole("tab", { name: /Source/ }));

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
    fireEvent.click(screen.getByRole("tab", { name: /Source/ }));

    expect(
      (screen.getByLabelText("Search requests") as HTMLInputElement).value,
    ).toBe("users");
  });

  it("separates request filters for different collections with the same name", () => {
    const api = createApiMock();
    const { rerender } = renderApp(api);

    fireEvent.click(screen.getByRole("tab", { name: /Source/ }));
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
    fireEvent.click(screen.getByRole("tab", { name: /Source/ }));

    expect(
      (screen.getByLabelText("Search requests") as HTMLInputElement).value,
    ).toBe("");

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
    fireEvent.click(screen.getByRole("tab", { name: /Source/ }));

    expect(
      (screen.getByLabelText("Search requests") as HTMLInputElement).value,
    ).toBe("users");
  });

  it("keeps request weights separately for collections with overlapping request ids", async () => {
    const api = createApiMock();
    appHookTestState.importHookState = createImportHookState(anotherCollection);
    const { rerender } = renderApp(api);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Controls" }));
    fireEvent.change(screen.getByLabelText("Traffic mode"), {
      target: { value: "weighted" },
    });
    openWorkflowStep("Source");

    fireEvent.change(screen.getByLabelText("Weight for POST login"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText("Weight for GET account"), {
      target: { value: "4" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    appHookTestState.importHookState =
      createImportHookState(importedCollection);
    rerender(createAppElement(api));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    openWorkflowStep("Source");
    expect(
      (screen.getByLabelText("Weight for GET users") as HTMLInputElement).value,
    ).toBe("1");

    fireEvent.change(screen.getByLabelText("Weight for GET users"), {
      target: { value: "7" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    appHookTestState.importHookState = createImportHookState(anotherCollection);
    rerender(createAppElement(api));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    openWorkflowStep("Source");
    expect(
      (screen.getByLabelText("Weight for POST login") as HTMLInputElement)
        .value,
    ).toBe("0");
    expect(
      (screen.getByLabelText("Weight for GET account") as HTMLInputElement)
        .value,
    ).toBe("4");

    appHookTestState.importHookState =
      createImportHookState(importedCollection);
    rerender(createAppElement(api));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    openWorkflowStep("Source");
    expect(
      (screen.getByLabelText("Weight for GET users") as HTMLInputElement).value,
    ).toBe("7");
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

    fireEvent.click(screen.getByRole("tab", { name: /Source/ }));
    expect(
      (screen.getByLabelText("Search requests") as HTMLInputElement).value,
    ).toBe("");
    expect((screen.getByLabelText("Method") as HTMLSelectElement).value).toBe(
      "all",
    );
  });

  it.each([
    ["an array payload", []],
    ["a string payload", "invalid"],
    ["a null payload", null],
    ["an array entries container", { version: 2, entries: [] }],
    ["a string entries container", { version: 2, entries: "invalid" }],
    ["a null entries container", { version: 2, entries: null }],
  ])("ignores collection filters stored as %s", (_description, stored) => {
    window.localStorage.setItem(
      "loadrift.ui.collection-filters",
      JSON.stringify(stored),
    );

    expect(() => renderApp(createApiMock())).not.toThrow();
    openWorkflowStep("Source");
    expectDefaultCollectionFilters();
  });

  it.each([
    ["an array", []],
    ["a string", "invalid"],
    ["null", null],
    [
      "a mismatched collection key",
      {
        collectionKey: "collection:not-the-current-key",
        methodFilter: "GET",
        searchQuery: "users",
      },
    ],
    [
      "a non-string collection key",
      { collectionKey: 42, methodFilter: "GET", searchQuery: "users" },
    ],
    [
      "a non-string search query",
      { methodFilter: "GET", searchQuery: ["users"] },
    ],
    ["a null method filter", { methodFilter: null, searchQuery: "users" }],
    [
      "an object method filter",
      { methodFilter: { method: "GET" }, searchQuery: "users" },
    ],
    ["an empty method filter", { methodFilter: "", searchQuery: "users" }],
    ["a padded method filter", { methodFilter: " GET ", searchQuery: "users" }],
  ])("ignores collection filter entry containing %s", (_description, entry) => {
    const collectionKey = createCollectionStorageKey(importedCollection);
    const storedEntry =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? { collectionKey, ...(entry as Record<string, unknown>) }
        : entry;
    window.localStorage.setItem(
      "loadrift.ui.collection-filters",
      JSON.stringify({
        version: 2,
        entries: { [collectionKey]: storedEntry },
      }),
    );

    expect(() => renderApp(createApiMock())).not.toThrow();
    openWorkflowStep("Source");
    expectDefaultCollectionFilters();
  });

  it("keeps a valid collection filter entry when a neighboring entry is corrupt", () => {
    const collectionKey = createCollectionStorageKey(importedCollection);
    const otherCollectionKey = createCollectionStorageKey(anotherCollection);
    window.localStorage.setItem(
      "loadrift.ui.collection-filters",
      JSON.stringify({
        version: 2,
        entries: {
          [otherCollectionKey]: {
            collectionKey: otherCollectionKey,
            methodFilter: null,
            searchQuery: ["login"],
          },
          [collectionKey]: {
            collectionKey,
            methodFilter: "GET",
            searchQuery: "users",
          },
        },
      }),
    );

    renderApp(createApiMock());
    openWorkflowStep("Source");

    expect(
      (screen.getByLabelText("Search requests") as HTMLInputElement).value,
    ).toBe("users");
    expect((screen.getByLabelText("Method") as HTMLSelectElement).value).toBe(
      "GET",
    );
  });

  it("falls back to all methods when a persisted method is absent from the collection", () => {
    const collectionKey = createCollectionStorageKey(importedCollection);
    window.localStorage.setItem(
      "loadrift.ui.collection-filters",
      JSON.stringify({
        version: 2,
        entries: {
          [collectionKey]: {
            collectionKey,
            methodFilter: "TRACE",
            searchQuery: "",
          },
        },
      }),
    );

    renderApp(createApiMock());
    openWorkflowStep("Source");

    expect((screen.getByLabelText("Method") as HTMLSelectElement).value).toBe(
      "all",
    );
    expect(screen.getByText("GET users")).toBeInTheDocument();
  });

  it("ignores collection filter storage that cannot be parsed", () => {
    window.localStorage.setItem(
      "loadrift.ui.collection-filters",
      "{not-valid-json",
    );

    expect(() => renderApp(createApiMock())).not.toThrow();
    openWorkflowStep("Source");
    expectDefaultCollectionFilters();
  });

  it("keeps working when storage access is blocked", () => {
    const localStorageGetter = vi
      .spyOn(window, "localStorage", "get")
      .mockImplementation(() => {
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
