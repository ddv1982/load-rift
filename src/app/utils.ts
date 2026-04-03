import type { RequestInfo, RuntimeVariable } from "../lib/loadrift/types";

const HOST_VARIABLE_KEYS = new Set([
  "baseUrl",
  "base_url",
  "environment",
  "enviroment",
]);

function sanitizeFileNamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function formatUtcTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

export function buildReportFileName(baseUrl?: string): string {
  const timestamp = formatUtcTimestamp(new Date());

  if (!baseUrl?.trim()) {
    return `loadrift-report-${timestamp}.html`;
  }

  try {
    const url = new URL(baseUrl);
    const pathLabel = url.pathname.split("/").filter(Boolean).join("-");
    const targetLabel = sanitizeFileNamePart(
      [url.hostname, pathLabel].filter(Boolean).join("-"),
    );

    return targetLabel
      ? `loadrift-report-${targetLabel}-${timestamp}.html`
      : `loadrift-report-${timestamp}.html`;
  } catch {
    const targetLabel = sanitizeFileNamePart(baseUrl);
    return targetLabel
      ? `loadrift-report-${targetLabel}-${timestamp}.html`
      : `loadrift-report-${timestamp}.html`;
  }
}

export function formatCount(label: string, count: number): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

export function truncateLog(log: string): string {
  if (!log.trim()) {
    return "No k6 runner output yet. Start a test to stream local process logs here.";
  }

  return log;
}

export function formatVariableLabel(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (value) => value.toUpperCase());
}

export function syncVariableOverrides(
  runtimeVariables: RuntimeVariable[],
  previousOverrides: Record<string, string>,
): Record<string, string> {
  const nextOverrides: Record<string, string> = {};

  for (const variable of runtimeVariables) {
    if (isHostVariableKey(variable.key)) {
      continue;
    }

    const previousOverride = previousOverrides[variable.key];
    if (previousOverride !== undefined) {
      nextOverrides[variable.key] = previousOverride;
    }
  }

  return nextOverrides;
}

export function syncSelectedRequestIds(
  requests: RequestInfo[],
  previousSelectedRequestIds: string[],
): string[] {
  if (!requests.length) {
    return [];
  }

  const requestIds = new Set(requests.map((request) => request.id));
  const nextSelectedRequestIds = previousSelectedRequestIds.filter((id) =>
    requestIds.has(id)
  );

  return nextSelectedRequestIds.length > 0
    ? nextSelectedRequestIds
    : requests.map((request) => request.id);
}

export function normalizeRequestWeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }

  return Math.max(0, Math.floor(value));
}

export function syncRequestWeights(
  requests: RequestInfo[],
  previousRequestWeights: Record<string, number>,
): Record<string, number> {
  if (!requests.length) {
    return {};
  }

  const nextRequestWeights: Record<string, number> = {};

  for (const request of requests) {
    const previousWeight = previousRequestWeights[request.id];
    nextRequestWeights[request.id] =
      typeof previousWeight === "number" && Number.isFinite(previousWeight)
        ? Math.max(0, Math.trunc(previousWeight))
        : 1;
  }

  return nextRequestWeights;
}

export function getRequestWeight(
  requestId: string,
  requestWeights: Record<string, number>,
): number {
  return normalizeRequestWeight(requestWeights[requestId]);
}

export function isHostVariableKey(key: string): boolean {
  return HOST_VARIABLE_KEYS.has(key);
}

export function getVariableValue(
  variable: RuntimeVariable,
  overrides: Record<string, string>,
): string {
  return overrides[variable.key] ?? variable.defaultValue ?? "";
}
