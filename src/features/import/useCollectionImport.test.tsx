import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CollectionInfo } from "../../lib/loadrift/types";
import {
  createLoadRiftApiMock as createApiMock,
  createLoadRiftApiWrapper as createWrapper,
} from "../../test/loadRiftApiTestUtils";
import { useCollectionImport } from "./useCollectionImport";

const importedCollection: CollectionInfo = {
  name: "Fixture Collection",
  requestCount: 1,
  folderCount: 0,
  requests: [
    {
      id: "request-0",
      name: "GET users",
      method: "GET",
      url: "https://api.example.com/users",
      folderPath: [],
    },
  ],
  runtimeVariables: [],
};

describe("useCollectionImport", () => {
  it("stores the imported collection after a successful file import", async () => {
    const api = createApiMock({
      importCollectionFromFile: vi.fn(async () => importedCollection),
    });
    const { result } = renderHook(() => useCollectionImport(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      await result.current.importFromFile("/tmp/fixture.postman_collection.json");
    });

    await waitFor(() => {
      expect(result.current.state.collection).toEqual(importedCollection);
    });

    expect(result.current.state.error).toBeNull();
    expect(result.current.state.isLoading).toBe(false);
    expect(api.importCollectionFromFile).toHaveBeenCalledWith({
      filePath: "/tmp/fixture.postman_collection.json",
    });
  });

  it("normalizes import failures through the Tauri error helper", async () => {
    const api = createApiMock({
      importCollectionFromFile: vi.fn(async () => {
        throw new Error("HTTP 404");
      }),
    });
    const { result } = renderHook(() => useCollectionImport(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      await result.current.importFromFile("/tmp/fixture.postman_collection.json");
    });

    expect(result.current.state).toEqual({
      isLoading: false,
      error: "HTTP 404",
      collection: null,
    });
  });

  it("keeps the previous collection when a replacement import fails", async () => {
    const api = createApiMock({
      importCollectionFromFile: vi
        .fn()
        .mockResolvedValueOnce(importedCollection)
        .mockRejectedValueOnce(new Error("HTTP 404")),
    });
    const { result } = renderHook(() => useCollectionImport(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      await result.current.importFromFile("/tmp/fixture.postman_collection.json");
    });

    await waitFor(() => {
      expect(result.current.state.collection).toEqual(importedCollection);
    });

    await act(async () => {
      await result.current.importFromFile("/tmp/replacement.postman_collection.json");
    });

    expect(result.current.state).toEqual({
      isLoading: false,
      error: "HTTP 404",
      collection: importedCollection,
    });
  });
});
