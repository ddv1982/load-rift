import type { PropsWithChildren } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoadRiftApiProvider } from "../../lib/loadrift/context";
import type { LoadRiftApi } from "../../lib/loadrift/api";
import type { SmokeTestResponse } from "../../lib/loadrift/types";
import { useSmokeTest } from "./useSmokeTest";

function createApiMock(overrides: Partial<LoadRiftApi> = {}): LoadRiftApi {
  return {
    importCollectionFromFile: vi.fn(),
    validateTestConfiguration: vi.fn(),
    smokeTestRequests: vi.fn(),
    startTest: vi.fn(),
    stopTest: vi.fn(),
    exportReport: vi.fn(),
    getTestStatus: vi.fn(),
    onK6Output: vi.fn(async () => () => {}),
    onK6Metrics: vi.fn(async () => () => {}),
    onK6Complete: vi.fn(async () => () => {}),
    onK6Error: vi.fn(async () => () => {}),
    ...overrides,
  };
}

function createWrapper(api: LoadRiftApi) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <LoadRiftApiProvider api={api}>{children}</LoadRiftApiProvider>;
  };
}

describe("useSmokeTest", () => {
  it("stores smoke test responses after a successful run", async () => {
    const response: SmokeTestResponse = {
      responses: [
        {
          requestId: "request-1",
          requestName: "SOAP login",
          method: "POST",
          url: "https://api.example.com/soap",
          statusCode: 200,
          durationMs: 41,
          ok: true,
          contentType: "text/xml; charset=utf-8",
          responseHeaders: {
            "content-type": "text/xml; charset=utf-8",
          },
          bodyPreview: "<Envelope>ok</Envelope>",
          errorMessage: null,
        },
      ],
    };
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => response),
    });
    const { result } = renderHook(() => useSmokeTest(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      await result.current.runSmokeTest({
        vus: 1,
        duration: "1s",
        rampUp: "instant",
        rampUpTime: "1s",
        thresholds: {},
        variableOverrides: {},
        advancedOptionsJson: "",
        selectedRequestIds: ["request-1"],
      });
    });

    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.result).toEqual(response);
    expect(result.current.state.error).toBeNull();
  });

  it("surfaces smoke test failures with a normalized message", async () => {
    const api = createApiMock({
      smokeTestRequests: vi.fn(async () => {
        throw new Error("401 Unauthorized");
      }),
    });
    const { result } = renderHook(() => useSmokeTest(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      await result.current.runSmokeTest({
        vus: 1,
        duration: "1s",
        rampUp: "instant",
        rampUpTime: "1s",
        thresholds: {},
        variableOverrides: {},
        advancedOptionsJson: "",
        selectedRequestIds: ["request-1"],
      });
    });

    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.result).toBeNull();
    expect(result.current.state.error).toBe("401 Unauthorized");
  });
});
