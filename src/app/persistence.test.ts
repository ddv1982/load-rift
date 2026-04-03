import { describe, expect, it } from "vitest";
import {
  createCollectionStorageKey,
  loadRunnerPreferences,
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
  it("persists traffic mode and zero-or-positive request weights", () => {
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
      requestWeights: {
        "request-a": 3,
        "request-b": 0,
      },
    });
  });
});
