import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SmokeTestResponse } from "../../lib/loadrift/types";
import {
  createLoadRiftApiMock as createApiMock,
  createLoadRiftApiWrapper as createWrapper,
  deferred,
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
        trafficMode: "sequential",
        rampUpTime: "1s",
        thresholds: {},
        requestHeaders: {},
        variableOverrides: {},
        advancedOptionsJson: "",
        selectedRequestIds: ["request-1"],
        requestWeights: {},
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
        trafficMode: "sequential",
        rampUpTime: "1s",
        thresholds: {},
        requestHeaders: {},
        variableOverrides: {},
        advancedOptionsJson: "",
        selectedRequestIds: ["request-1"],
        requestWeights: {},
      });
    });

    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.result).toBeNull();
    expect(result.current.state.error).toBe("401 Unauthorized");
  });

  it("ignores stale smoke test responses after a newer run starts", async () => {
    const firstRequest = deferred<SmokeTestResponse>();
    const secondResponse: SmokeTestResponse = {
      responses: [
        {
          requestId: "request-2",
          requestName: "GET latest",
          method: "GET",
          url: "https://api.example.com/latest",
          statusCode: 200,
          durationMs: 12,
          ok: true,
          contentType: "application/json",
          responseHeaders: {},
          bodyPreview: "{}",
          errorMessage: null,
        },
      ],
    };
    const firstResponse: SmokeTestResponse = {
      responses: [
        {
          ...secondResponse.responses[0]!,
          requestId: "request-1",
          requestName: "GET stale",
        },
      ],
    };
    const api = createApiMock({
      smokeTestRequests: vi
        .fn()
        .mockReturnValueOnce(firstRequest.promise)
        .mockResolvedValueOnce(secondResponse),
    });
    const { result } = renderHook(() => useSmokeTest(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      void result.current.runSmokeTest({
        vus: 1,
        duration: "1s",
        rampUp: "instant",
        trafficMode: "sequential",
        rampUpTime: "1s",
        thresholds: {},
        requestHeaders: {},
        variableOverrides: {},
        advancedOptionsJson: "",
        selectedRequestIds: ["request-1"],
        requestWeights: {},
      });
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.runSmokeTest({
        vus: 1,
        duration: "1s",
        rampUp: "instant",
        trafficMode: "sequential",
        rampUpTime: "1s",
        thresholds: {},
        requestHeaders: {},
        variableOverrides: {},
        advancedOptionsJson: "",
        selectedRequestIds: ["request-2"],
        requestWeights: {},
      });
    });

    await act(async () => {
      firstRequest.resolve(firstResponse);
      await firstRequest.promise;
    });

    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.result).toEqual(secondResponse);
  });

  it("ignores stale smoke test failures after a newer run succeeds", async () => {
    const firstRequest = deferred<SmokeTestResponse>();
    const secondResponse: SmokeTestResponse = {
      responses: [],
    };
    const api = createApiMock({
      smokeTestRequests: vi
        .fn()
        .mockReturnValueOnce(firstRequest.promise)
        .mockResolvedValueOnce(secondResponse),
    });
    const { result } = renderHook(() => useSmokeTest(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      void result.current.runSmokeTest({
        vus: 1,
        duration: "1s",
        rampUp: "instant",
        trafficMode: "sequential",
        rampUpTime: "1s",
        thresholds: {},
        requestHeaders: {},
        variableOverrides: {},
        advancedOptionsJson: "",
        selectedRequestIds: ["request-1"],
        requestWeights: {},
      });
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.runSmokeTest({
        vus: 1,
        duration: "1s",
        rampUp: "instant",
        trafficMode: "sequential",
        rampUpTime: "1s",
        thresholds: {},
        requestHeaders: {},
        variableOverrides: {},
        advancedOptionsJson: "",
        selectedRequestIds: ["request-2"],
        requestWeights: {},
      });
    });

    await act(async () => {
      firstRequest.reject(new Error("Stale smoke failure"));
      await firstRequest.promise.catch(() => {});
    });

    expect(result.current.state).toEqual({
      isRunning: false,
      result: secondResponse,
      error: null,
    });
  });

  it("ignores stale smoke test results after clearSmokeTest", async () => {
    const request = deferred<SmokeTestResponse>();
    const response: SmokeTestResponse = {
      responses: [],
    };
    const api = createApiMock({
      smokeTestRequests: vi.fn(() => request.promise),
    });
    const { result } = renderHook(() => useSmokeTest(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      void result.current.runSmokeTest({
        vus: 1,
        duration: "1s",
        rampUp: "instant",
        trafficMode: "sequential",
        rampUpTime: "1s",
        thresholds: {},
        requestHeaders: {},
        variableOverrides: {},
        advancedOptionsJson: "",
        selectedRequestIds: ["request-1"],
        requestWeights: {},
      });
      await Promise.resolve();
    });

    act(() => {
      result.current.clearSmokeTest();
    });

    await act(async () => {
      request.resolve(response);
      await request.promise;
    });

    expect(result.current.state).toEqual({
      isRunning: false,
      result: null,
      error: null,
    });
  });
});
