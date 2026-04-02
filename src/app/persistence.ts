import type {
  CollectionInfo,
  K6Options,
  RampUpStrategy,
} from "../lib/loadrift/types";

const STORAGE_KEYS = {
  sidebarWidth: "loadrift.ui.sidebar-width",
  activeHarnessTab: "loadrift.ui.active-harness-tab",
  collectionFilters: "loadrift.ui.collection-filters",
  curlInput: "loadrift.ui.curl-input",
  runnerPreferences: "loadrift.ui.runner-preferences",
} as const;

export type HarnessTab = "controls" | "variables" | "advanced";

interface PersistedCollectionFilters {
  collectionKey: string;
  methodFilter: string;
  searchQuery: string;
}

interface PersistedCollectionFilterStore {
  version: 2;
  entries: Record<string, PersistedCollectionFilters>;
}

interface PersistedRunnerPreferences {
  vus: number;
  duration: string;
  rampUp: RampUpStrategy;
  rampUpTime?: string;
  thresholds: {
    p95ResponseTime?: number;
    errorRate?: number;
  };
}

type StorageArea = "local" | "session";

function resolveStorage(area: StorageArea): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return area === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function readStorage<T>(key: string, area: StorageArea = "local"): T | null {
  const storage = resolveStorage(area);
  if (!storage) {
    return null;
  }

  try {
    const value = storage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

function writeStorage<T>(key: string, value: T, area: StorageArea = "local") {
  const storage = resolveStorage(area);
  if (!storage) {
    return;
  }

  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures so the UI still works in restricted environments.
  }
}

function hashString(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createCollectionStorageKey(collection: CollectionInfo): string {
  const requestSignatures = collection.requests
    .map((request) =>
      JSON.stringify({
        method: request.method,
        name: request.name,
        url: request.url,
        folderPath: request.folderPath,
      })
    )
    .sort();
  const runtimeVariableSignatures = collection.runtimeVariables
    .map((variable) =>
      JSON.stringify({
        key: variable.key,
        defaultValue: variable.defaultValue ?? "",
      })
    )
    .sort();
  const signature = JSON.stringify({
    name: collection.name,
    requestCount: requestSignatures.length,
    folderCount: collection.folderCount,
    requests: requestSignatures,
    runtimeVariables: runtimeVariableSignatures,
  });

  return `collection:${hashString(signature)}`;
}

function normalizeCollectionFilterStore(
  stored: unknown,
): PersistedCollectionFilterStore | null {
  if (!stored || typeof stored !== "object") {
    return null;
  }

  if ("version" in stored && "entries" in stored) {
    const versionedStore = stored as PersistedCollectionFilterStore;
    if (versionedStore.version === 2 && versionedStore.entries) {
      return versionedStore;
    }
  }

  return null;
}

export function loadSidebarWidth(defaultWidth: number): number {
  const stored = readStorage<number>(STORAGE_KEYS.sidebarWidth);
  if (typeof stored !== "number" || Number.isNaN(stored)) {
    return defaultWidth;
  }

  return Math.max(24, Math.min(46, stored));
}

export function saveSidebarWidth(width: number) {
  writeStorage(STORAGE_KEYS.sidebarWidth, width);
}

export function loadHarnessTab(defaultTab: HarnessTab): HarnessTab {
  const stored = readStorage<string>(STORAGE_KEYS.activeHarnessTab);
  if (stored === "controls" || stored === "variables" || stored === "advanced") {
    return stored;
  }

  return defaultTab;
}

export function saveHarnessTab(tab: HarnessTab) {
  writeStorage(STORAGE_KEYS.activeHarnessTab, tab);
}

export function loadCollectionFilters(
  collectionKey: string,
): PersistedCollectionFilters | null {
  const stored = normalizeCollectionFilterStore(readStorage(STORAGE_KEYS.collectionFilters));
  if (!stored) {
    return null;
  }

  return stored.entries[collectionKey] ?? null;
}

export function saveCollectionFilters(filters: PersistedCollectionFilters) {
  const stored = normalizeCollectionFilterStore(readStorage(STORAGE_KEYS.collectionFilters));
  writeStorage<PersistedCollectionFilterStore>(STORAGE_KEYS.collectionFilters, {
    version: 2,
    entries: {
      ...(stored?.entries ?? {}),
      [filters.collectionKey]: {
        collectionKey: filters.collectionKey,
        methodFilter: filters.methodFilter,
        searchQuery: filters.searchQuery,
      },
    },
  });
}

export function loadCurlInput(defaultValue: string) {
  const stored = readStorage<string>(STORAGE_KEYS.curlInput, "session");
  return typeof stored === "string" ? stored : defaultValue;
}

export function saveCurlInput(value: string) {
  writeStorage(STORAGE_KEYS.curlInput, value, "session");
}

export function loadRunnerPreferences(defaultOptions: K6Options): K6Options {
  const stored = readStorage<Partial<PersistedRunnerPreferences>>(
    STORAGE_KEYS.runnerPreferences,
  );

  if (!stored) {
    return defaultOptions;
  }

  const rampUp =
    stored.rampUp === "instant" ||
    stored.rampUp === "gradual" ||
    stored.rampUp === "staged"
      ? stored.rampUp
      : defaultOptions.rampUp;

  const thresholds: K6Options["thresholds"] = {};
  const persistedP95 = stored.thresholds?.p95ResponseTime;
  if (typeof persistedP95 === "number" && !Number.isNaN(persistedP95)) {
    thresholds.p95ResponseTime = persistedP95;
  } else if (defaultOptions.thresholds.p95ResponseTime !== undefined) {
    thresholds.p95ResponseTime = defaultOptions.thresholds.p95ResponseTime;
  }

  const persistedErrorRate = stored.thresholds?.errorRate;
  if (typeof persistedErrorRate === "number" && !Number.isNaN(persistedErrorRate)) {
    thresholds.errorRate = persistedErrorRate;
  } else if (defaultOptions.thresholds.errorRate !== undefined) {
    thresholds.errorRate = defaultOptions.thresholds.errorRate;
  }

  const nextOptions: K6Options = {
    ...defaultOptions,
    vus:
      typeof stored.vus === "number" && !Number.isNaN(stored.vus)
        ? stored.vus
        : defaultOptions.vus,
    duration:
      typeof stored.duration === "string" && stored.duration.trim()
        ? stored.duration
        : defaultOptions.duration,
    rampUp,
    thresholds,
  };

  const resolvedRampUpTime =
    typeof stored.rampUpTime === "string"
      ? stored.rampUpTime
      : defaultOptions.rampUpTime;
  if (resolvedRampUpTime !== undefined) {
    nextOptions.rampUpTime = resolvedRampUpTime;
  }

  return nextOptions;
}

export function saveRunnerPreferences(options: K6Options) {
  const thresholds: PersistedRunnerPreferences["thresholds"] = {};
  if (options.thresholds.p95ResponseTime !== undefined) {
    thresholds.p95ResponseTime = options.thresholds.p95ResponseTime;
  }
  if (options.thresholds.errorRate !== undefined) {
    thresholds.errorRate = options.thresholds.errorRate;
  }

  const persisted: PersistedRunnerPreferences = {
    vus: options.vus,
    duration: options.duration,
    rampUp: options.rampUp,
    thresholds,
  };
  if (options.rampUpTime !== undefined) {
    persisted.rampUpTime = options.rampUpTime;
  }

  writeStorage(STORAGE_KEYS.runnerPreferences, persisted);
}
