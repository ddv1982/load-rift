import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SmokeTestResponse } from "../../lib/loadrift/types";
import {
  createLoadRiftApiMock as createApiMock,
  createLoadRiftApiWrapper as createWrapper,
} from "../../test/loadRiftApiTestUtils";
import { useSmokeTest } from "./useSmokeTest";

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
