import { describe, expect, it } from "vitest";
import {
  createCollectionStorageKey,
  loadCollectionRequestWeights,
  loadRunnerPreferences,
  saveCollectionRequestWeights,
  saveRunnerPreferences,
} from "./persistence";
import type { CollectionInfo } from "../lib/loadrift/types";
import { DEFAULT_K6_OPTIONS } from "../lib/loadrift/types";

const orderedCollection: CollectionInfo = {
  name: "Stable Key Collection",
  requestCount: 3,
  folderCount: 1,
  requests: [
    {
      id: "request-a",
      name: "Root overview",
      method: "GET",
      url: "{{environment}}/overview",
      folderPath: [],
    },
    {
      id: "request-b",
      name: "POST login",
      method: "POST",
      url: "{{environment}}/login",
      folderPath: ["Auth"],
    },
    {
      id: "request-c",
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

const reorderedCollection: CollectionInfo = {
  ...orderedCollection,
  requests: [
    orderedCollection.requests[2]!,
    orderedCollection.requests[0]!,
    orderedCollection.requests[1]!,
  ],
};

describe("createCollectionStorageKey", () => {
  it("stays stable when the same requests are reordered", () => {
    expect(createCollectionStorageKey(reorderedCollection)).toBe(
      createCollectionStorageKey(orderedCollection),
    );
  });
});

describe("runner preferences persistence", () => {
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["decimal", 1.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["null", null],
    ["string", "4"],
  ])(
    "drops persisted invalid %s VU values in favor of defaults",
    (_label, vus) => {
      window.localStorage.setItem(
        "loadrift.ui.runner-preferences",
        JSON.stringify({
          ...DEFAULT_K6_OPTIONS,
          vus,
        }),
      );

      expect(loadRunnerPreferences(DEFAULT_K6_OPTIONS).vus).toBe(
        DEFAULT_K6_OPTIONS.vus,
      );
    },
  );

  it("does not persist invalid VU values", () => {
    saveRunnerPreferences({
      ...DEFAULT_K6_OPTIONS,
      vus: Number.POSITIVE_INFINITY,
    });

    expect(loadRunnerPreferences(DEFAULT_K6_OPTIONS).vus).toBe(
      DEFAULT_K6_OPTIONS.vus,
    );
  });

  it("drops persisted decimal thresholds in favor of defaults", () => {
    window.localStorage.setItem(
      "loadrift.ui.runner-preferences",
      JSON.stringify({
        ...DEFAULT_K6_OPTIONS,
        thresholds: {
          p95ResponseTime: 2000.5,
          errorRate: 5.5,
        },
      }),
    );

    expect(loadRunnerPreferences(DEFAULT_K6_OPTIONS).thresholds).toEqual(
      DEFAULT_K6_OPTIONS.thresholds,
    );
  });

  it("persists traffic mode without global request weights", () => {
    saveRunnerPreferences({
      ...DEFAULT_K6_OPTIONS,
      trafficMode: "weighted",
      requestWeights: {
        "request-a": 3,
        "request-b": 0,
      },
    });

    expect(loadRunnerPreferences(DEFAULT_K6_OPTIONS)).toMatchObject({
      trafficMode: "weighted",
      requestWeights: {},
    });
  });

  it("does not persist runtime request headers or body overrides", () => {
    saveRunnerPreferences({
      ...DEFAULT_K6_OPTIONS,
      requestHeaders: {
        Customerid: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        Authorization: "Basic abc123",
      },
      requestBodyOverride: {
        requestId: "request-a",
        body: '{"module":"Inbreeding"}',
      },
    });

    const loadedPreferences = loadRunnerPreferences(DEFAULT_K6_OPTIONS);
    expect(loadedPreferences.requestHeaders).toEqual({});
    expect(loadedPreferences.requestBodyOverride).toBeUndefined();
  });

  it("scopes request weights by collection key", () => {
    const firstCollectionKey = createCollectionStorageKey(orderedCollection);
    const secondCollectionKey = createCollectionStorageKey({
      ...orderedCollection,
      name: "Different Collection",
      requests: [
        {
          ...orderedCollection.requests[0]!,
          name: "Different request with reused id",
        },
      ],
    });

    saveCollectionRequestWeights(firstCollectionKey, {
      "request-a": 3,
      "request-b": 0,
    });
    saveCollectionRequestWeights(secondCollectionKey, {
      "request-a": 8,
    });

    expect(loadCollectionRequestWeights(firstCollectionKey)).toEqual({
      "request-a": 3,
      "request-b": 0,
    });
    expect(loadCollectionRequestWeights(secondCollectionKey)).toEqual({
      "request-a": 8,
    });
  });
});
