import type { PropsWithChildren } from "react";
import { vi } from "vitest";
import type { LoadRiftApi } from "../lib/loadrift/api";
import { LoadRiftApiProvider } from "../lib/loadrift/context";
import type { K6Options, SmokeTestResponse } from "../lib/loadrift/types";

export function createLoadRiftApiMock(
  overrides: Partial<LoadRiftApi> = {},
): LoadRiftApi {
  const emptySmokeTestResponse: SmokeTestResponse = {
    responses: [],
  };

  return {
    importCollectionFromFile: vi.fn(),
    validateTestConfiguration: vi.fn((_input: { options: K6Options }) =>
      Promise.resolve({
        ready: true,
        message: "Configuration looks ready to run.",
      }),
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

export function createLoadRiftApiWrapper(api: LoadRiftApi) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <LoadRiftApiProvider api={api}>{children}</LoadRiftApiProvider>;
  };
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
