import { render } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "../App";
import { LoadRiftApiProvider } from "../../lib/loadrift/context";
import type { LoadRiftApi } from "../../lib/loadrift/api";
import type { CollectionInfo, K6Options, SmokeTestResponse } from "../../lib/loadrift/types";

export const importedCollection: CollectionInfo = {
  name: "Fixture Collection",
  requestCount: 1,
  folderCount: 0,
  requests: [
    {
      id: "request-0",
      name: "GET users",
      method: "GET",
      url: "{{environment}}/users",
      folderPath: [],
    },
  ],
  runtimeVariables: [
    {
      key: "environment",
    },
  ],
};

export const anotherCollection: CollectionInfo = {
  name: "Second Fixture Collection",
  requestCount: 2,
  folderCount: 1,
  requests: [
    {
      id: "request-0",
      name: "POST login",
      method: "POST",
      url: "{{environment}}/login",
      folderPath: ["Auth"],
    },
    {
      id: "request-1",
      name: "GET account",
      method: "GET",
      url: "{{environment}}/account",
      folderPath: ["Auth"],
    },
  ],
  runtimeVariables: [
    {
      key: "environment",
    },
  ],
};

export const orderedCollection: CollectionInfo = {
  name: "Ordered Fixture Collection",
  requestCount: 4,
  folderCount: 1,
  requests: [
    {
      id: "request-0",
      name: "Root overview",
      method: "GET",
      url: "{{environment}}/overview",
      folderPath: [],
    },
    {
      id: "request-1",
      name: "POST login",
      method: "POST",
      url: "{{environment}}/login",
      folderPath: ["Auth"],
    },
    {
      id: "request-2",
      name: "GET account",
      method: "GET",
      url: "{{environment}}/account",
      folderPath: ["Auth"],
    },
    {
      id: "request-3",
      name: "Root teardown",
      method: "DELETE",
      url: "{{environment}}/teardown",
      folderPath: [],
    },
  ],
  runtimeVariables: [],
};

export const separatorFolderCollection: CollectionInfo = {
  name: "Separator Folder Collection",
  requestCount: 2,
  folderCount: 3,
  requests: [
    {
      id: "request-0",
      name: "Slash folder request",
      method: "GET",
      url: "{{environment}}/slash",
      folderPath: ["A / B"],
    },
    {
      id: "request-1",
      name: "Nested folder request",
      method: "GET",
      url: "{{environment}}/nested",
      folderPath: ["A", "B"],
    },
  ],
  runtimeVariables: [],
};

export const sameNameDifferentCollection: CollectionInfo = {
  name: "Fixture Collection",
  requestCount: 1,
  folderCount: 0,
  requests: [
    {
      id: "request-0",
      name: "POST login",
      method: "POST",
      url: "{{environment}}/login",
      folderPath: [],
    },
  ],
  runtimeVariables: [
    {
      key: "environment",
    },
  ],
};

export function createImportHookState(collection: CollectionInfo | null = importedCollection) {
  return {
    state: {
      isLoading: false,
      error: null,
      collection,
    },
    importFromFile: vi.fn(),
    reportError: vi.fn(),
    reset: vi.fn(),
  };
}

export function createTestHookState() {
  return {
    state: {
      status: "idle" as const,
      metrics: {
        activeVus: 0,
        totalRequests: 0,
        failedRequests: 0,
        errorRate: 0,
        p50ResponseTime: 0,
        p95ResponseTime: 0,
        requestsPerSecond: 0,
      },
      result: null,
      error: null,
      output: "",
      isStarting: false,
      isBusy: false,
      isRunning: false,
    },
    refreshStatus: vi.fn(),
    startTest: vi.fn(),
    stopTest: vi.fn(),
  };
}

export function createSmokeHookState() {
  return {
    state: {
      isRunning: false,
      result: null as SmokeTestResponse | null,
      error: null,
    },
    runSmokeTest: vi.fn(),
    clearSmokeTest: vi.fn(),
  };
}

export function createApiMock(overrides: Partial<LoadRiftApi> = {}): LoadRiftApi {
  const emptySmokeTestResponse: SmokeTestResponse = {
    responses: [],
  };

  return {
    importCollectionFromFile: vi.fn(),
    validateTestConfiguration: vi.fn((_input: { options: K6Options }) =>
      Promise.resolve({
        ready: true,
        message: "Configuration looks ready to run.",
      })
    ),
    smokeTestRequests: vi.fn(() => Promise.resolve(emptySmokeTestResponse)),
    startTest: vi.fn(),
    stopTest: vi.fn(),
    exportReport: vi.fn(),
    getTestStatus: vi.fn(),
    onK6Output: vi.fn(() => Promise.resolve(() => {})),
    onK6Metrics: vi.fn(() => Promise.resolve(() => {})),
    onK6Complete: vi.fn(() => Promise.resolve(() => {})),
    onK6Error: vi.fn(() => Promise.resolve(() => {})),
    ...overrides,
  };
}

export function createAppElement(api: LoadRiftApi) {
  return (
    <LoadRiftApiProvider api={api}>
      <App />
    </LoadRiftApiProvider>
  );
}

export function renderApp(api: LoadRiftApi) {
  return render(createAppElement(api));
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
