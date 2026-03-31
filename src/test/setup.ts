import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.has(key) ? values.get(key) ?? null : null;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
  } as Storage;
}

if (typeof window !== "undefined") {
  const storages = {
    localStorage: createMemoryStorage(),
    sessionStorage: createMemoryStorage(),
  } as const;

  // Node 25 exposes a nonstandard global localStorage that can leak into jsdom.
  for (const [name, storage] of Object.entries(storages)) {
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      get: () => storage,
    });
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
