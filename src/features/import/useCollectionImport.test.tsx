import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CollectionInfo } from "../../lib/loadrift/types";
import {
  createLoadRiftApiMock as createApiMock,
  createLoadRiftApiWrapper as createWrapper,
  deferred,
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

const replacementCollection: CollectionInfo = {
  ...importedCollection,
  name: "Replacement Collection",
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

  it("ignores stale imports after a newer import completes", async () => {
    const firstImport = deferred<CollectionInfo>();
    const api = createApiMock({
      importCollectionFromFile: vi
        .fn()
        .mockReturnValueOnce(firstImport.promise)
        .mockResolvedValueOnce(replacementCollection),
    });
    const { result } = renderHook(() => useCollectionImport(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      void result.current.importFromFile("/tmp/stale.postman_collection.json");
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.importFromFile("/tmp/replacement.postman_collection.json");
    });

    await act(async () => {
      firstImport.resolve(importedCollection);
      await firstImport.promise;
    });

    expect(result.current.state).toEqual({
      isLoading: false,
      error: null,
      collection: replacementCollection,
    });
  });

  it("ignores stale import failures after a newer import completes", async () => {
    const firstImport = deferred<CollectionInfo>();
    const api = createApiMock({
      importCollectionFromFile: vi
        .fn()
        .mockReturnValueOnce(firstImport.promise)
        .mockResolvedValueOnce(replacementCollection),
    });
    const { result } = renderHook(() => useCollectionImport(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      void result.current.importFromFile("/tmp/stale.postman_collection.json");
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.importFromFile("/tmp/replacement.postman_collection.json");
    });

    await act(async () => {
      firstImport.reject(new Error("Stale import failure"));
      await firstImport.promise.catch(() => {});
    });

    expect(result.current.state).toEqual({
      isLoading: false,
      error: null,
      collection: replacementCollection,
    });
  });

  it("ignores stale imports after reset", async () => {
    const importRequest = deferred<CollectionInfo>();
    const api = createApiMock({
      importCollectionFromFile: vi.fn(() => importRequest.promise),
    });
    const { result } = renderHook(() => useCollectionImport(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      void result.current.importFromFile("/tmp/stale.postman_collection.json");
      await Promise.resolve();
    });

    act(() => {
      result.current.reset();
    });

    await act(async () => {
      importRequest.resolve(importedCollection);
      await importRequest.promise;
    });

    expect(result.current.state).toEqual({
      isLoading: false,
      error: null,
      collection: null,
    });
  });

  it("ignores stale imports after reportError", async () => {
    const importRequest = deferred<CollectionInfo>();
    const api = createApiMock({
      importCollectionFromFile: vi.fn(() => importRequest.promise),
    });
    const { result } = renderHook(() => useCollectionImport(), {
      wrapper: createWrapper(api),
    });

    await act(async () => {
      void result.current.importFromFile("/tmp/stale.postman_collection.json");
      await Promise.resolve();
    });

    act(() => {
      result.current.reportError("Picker failed");
    });

    await act(async () => {
      importRequest.resolve(importedCollection);
      await importRequest.promise;
    });

    expect(result.current.state).toEqual({
      isLoading: false,
      error: "Picker failed",
      collection: null,
    });
  });
});
