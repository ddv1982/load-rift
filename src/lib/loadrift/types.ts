export type TestStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export type RampUpStrategy = "instant" | "gradual" | "staged";

export type TrafficMode = "sequential" | "weighted";

export interface ThresholdConfig {
  p95ResponseTime?: number;
  errorRate?: number;
}

export interface K6Options {
  vus: number;
  duration: string;
  rampUp: RampUpStrategy;
  rampUpTime?: string;
  thresholds: ThresholdConfig;
  authToken?: string;
  baseUrl?: string;
  requestHeaders: Record<string, string>;
  requestBodyOverride?: RequestBodyOverride;
  variableOverrides: Record<string, string>;
  advancedOptionsJson?: string;
  selectedRequestIds: string[];
  trafficMode: TrafficMode;
  requestWeights: Record<string, number>;
}

export interface RequestBodyOverride {
  requestId: string;
  body: string;
}

export interface RuntimeVariable {
  key: string;
  defaultValue?: string;
}

export interface RequestInfo {
  id: string;
  name: string;
  method: string;
  url: string;
  folderPath: string[];
}

export interface CollectionInfo {
  name: string;
  requestCount: number;
  folderCount: number;
  requests: RequestInfo[];
  runtimeVariables: RuntimeVariable[];
}

export interface LiveMetrics {
  activeVus: number;
  totalRequests: number;
  failedRequests: number;
  errorRate: number;
  avgResponseTime: number;
  p50ResponseTime: number;
  p95ResponseTime: number;
  maxResponseTime: number;
  requestsPerSecond: number;
}

export interface ThresholdResult {
  name: string;
  passed: boolean;
  actual: number;
  threshold: number;
}

export type TestResultStatus = "passed" | "warning" | "failed";

export type TestResultSource = "summary" | "liveMetricsFallback";

export interface TestMetrics {
  totalRequests: number;
  failedRequests: number;
  avgResponseTime: number;
  p50ResponseTime: number;
  p95ResponseTime: number;
  maxResponseTime: number;
  requestsPerSecond: number;
}

export interface TestResult {
  status: TestResultStatus;
  metrics: TestMetrics;
  thresholds: ThresholdResult[];
}

export interface StartTestResponse {
  runId: string;
}

export interface RunMetricsEvent {
  runId: string;
  metrics: LiveMetrics;
}

export interface RunErrorEvent {
  runId: string;
  message: string;
}

export interface TestCompletion {
  runId: string;
  runState: TestStatus;
  finishReason: string;
  metrics: LiveMetrics;
  result: TestResult;
  resultSource: TestResultSource;
  summaryIssue: string | null;
  errorMessage: string | null;
}

export interface GetTestStatusResponse {
  runId: string | null;
  status: TestStatus;
  isRunning: boolean;
  metrics: LiveMetrics | null;
  result: TestResult | null;
  finishReason: string | null;
  errorMessage: string | null;
  resultSource: TestResultSource | null;
  summaryIssue: string | null;
}

export interface ValidateTestConfigurationResponse {
  ready: boolean;
  message: string | null;
}

export interface SmokeTestResult {
  requestId: string;
  requestName: string;
  method: string;
  url: string;
  statusCode: number | null;
  durationMs: number;
  ok: boolean;
  contentType: string | null;
  responseHeaders: Record<string, string>;
  bodyPreview: string | null;
  errorMessage: string | null;
}

export interface SmokeTestResponse {
  responses: SmokeTestResult[];
}

export const DEFAULT_K6_OPTIONS: K6Options = {
  vus: 10,
  duration: "1m",
  rampUp: "instant",
  rampUpTime: "30s",
  thresholds: {
    p95ResponseTime: 2000,
    errorRate: 5,
  },
  requestHeaders: {},
  variableOverrides: {},
  advancedOptionsJson: "",
  selectedRequestIds: [],
  trafficMode: "sequential",
  requestWeights: {},
};

export const DEFAULT_LIVE_METRICS: LiveMetrics = {
  activeVus: 0,
  totalRequests: 0,
  failedRequests: 0,
  errorRate: 0,
  avgResponseTime: 0,
  p50ResponseTime: 0,
  p95ResponseTime: 0,
  maxResponseTime: 0,
  requestsPerSecond: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeTestStatus(value: unknown, fallback: TestStatus): TestStatus {
  return value === "idle" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped"
    ? value
    : fallback;
}

function normalizeCompletionStatus(value: unknown): TestStatus {
  return value === "completed" || value === "failed" || value === "stopped"
    ? value
    : "failed";
}

function normalizeTestResultStatus(
  value: unknown,
  fallback: TestResultStatus,
): TestResultStatus {
  return value === "passed" || value === "warning" || value === "failed"
    ? value
    : fallback;
}

function normalizeTestResultSource(value: unknown): TestResultSource | null {
  return value === "summary" || value === "liveMetricsFallback" ? value : null;
}

function normalizeTestMetrics(value: unknown): TestMetrics {
  const metrics = isRecord(value) ? value : {};

  return {
    totalRequests: normalizeNumber(metrics.totalRequests, 0),
    failedRequests: normalizeNumber(metrics.failedRequests, 0),
    avgResponseTime: normalizeNumber(metrics.avgResponseTime, 0),
    p50ResponseTime: normalizeNumber(metrics.p50ResponseTime, 0),
    p95ResponseTime: normalizeNumber(metrics.p95ResponseTime, 0),
    maxResponseTime: normalizeNumber(metrics.maxResponseTime, 0),
    requestsPerSecond: normalizeNumber(metrics.requestsPerSecond, 0),
  };
}

function normalizeThresholdResult(value: unknown): ThresholdResult | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    name: normalizeString(value.name, "threshold"),
    passed: value.passed === true,
    actual: normalizeNumber(value.actual, 0),
    threshold: normalizeNumber(value.threshold, 0),
  };
}

export function normalizeLiveMetrics(value: unknown): LiveMetrics {
  const metrics = isRecord(value) ? value : {};

  return {
    activeVus: normalizeNumber(
      metrics.activeVus,
      DEFAULT_LIVE_METRICS.activeVus,
    ),
    totalRequests: normalizeNumber(
      metrics.totalRequests,
      DEFAULT_LIVE_METRICS.totalRequests,
    ),
    failedRequests: normalizeNumber(
      metrics.failedRequests,
      DEFAULT_LIVE_METRICS.failedRequests,
    ),
    errorRate: normalizeNumber(
      metrics.errorRate,
      DEFAULT_LIVE_METRICS.errorRate,
    ),
    avgResponseTime: normalizeNumber(
      metrics.avgResponseTime,
      DEFAULT_LIVE_METRICS.avgResponseTime,
    ),
    p50ResponseTime: normalizeNumber(
      metrics.p50ResponseTime,
      DEFAULT_LIVE_METRICS.p50ResponseTime,
    ),
    p95ResponseTime: normalizeNumber(
      metrics.p95ResponseTime,
      DEFAULT_LIVE_METRICS.p95ResponseTime,
    ),
    maxResponseTime: normalizeNumber(
      metrics.maxResponseTime,
      DEFAULT_LIVE_METRICS.maxResponseTime,
    ),
    requestsPerSecond: normalizeNumber(
      metrics.requestsPerSecond,
      DEFAULT_LIVE_METRICS.requestsPerSecond,
    ),
  };
}

export function normalizeTestResult(value: unknown): TestResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const thresholds = Array.isArray(value.thresholds)
    ? value.thresholds.flatMap((threshold) => {
        const normalized = normalizeThresholdResult(threshold);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    status: normalizeTestResultStatus(value.status, "failed"),
    metrics: normalizeTestMetrics(value.metrics),
    thresholds,
  };
}

export function normalizeRunMetricsEvent(
  value: unknown,
): RunMetricsEvent | null {
  if (!isRecord(value) || typeof value.runId !== "string") {
    return null;
  }

  return {
    runId: value.runId,
    metrics: normalizeLiveMetrics(value.metrics),
  };
}

export function normalizeRunErrorEvent(value: unknown): RunErrorEvent | null {
  if (!isRecord(value) || typeof value.runId !== "string") {
    return null;
  }

  return {
    runId: value.runId,
    message: normalizeString(
      value.message,
      "The k6 runner reported an unknown error.",
    ),
  };
}

export function normalizeStartTestResponse(
  value: unknown,
  fallbackRunId: string,
): StartTestResponse {
  if (!isRecord(value) || typeof value.runId !== "string") {
    return { runId: fallbackRunId };
  }

  return { runId: value.runId };
}

export function normalizeTestCompletion(value: unknown): TestCompletion | null {
  if (!isRecord(value) || typeof value.runId !== "string") {
    return null;
  }

  return {
    runId: value.runId,
    runState: normalizeCompletionStatus(value.runState),
    finishReason: normalizeString(value.finishReason, "unknown"),
    metrics: normalizeLiveMetrics(value.metrics),
    result: normalizeTestResult(value.result) ?? {
      status: "failed",
      metrics: normalizeTestMetrics(null),
      thresholds: [],
    },
    resultSource: normalizeTestResultSource(value.resultSource) ?? "summary",
    summaryIssue: normalizeNullableString(value.summaryIssue),
    errorMessage: normalizeNullableString(value.errorMessage),
  };
}

export function normalizeGetTestStatusResponse(
  value: unknown,
): GetTestStatusResponse {
  if (!isRecord(value)) {
    return {
      runId: null,
      status: "idle",
      isRunning: false,
      metrics: null,
      result: null,
      finishReason: null,
      errorMessage: null,
      resultSource: null,
      summaryIssue: null,
    };
  }

  const runId = typeof value.runId === "string" ? value.runId : null;
  const isRunning = value.isRunning === true && runId !== null;

  return {
    runId,
    status: normalizeTestStatus(value.status, isRunning ? "running" : "idle"),
    isRunning,
    metrics:
      value.metrics === null ? null : normalizeLiveMetrics(value.metrics),
    result: value.result === null ? null : normalizeTestResult(value.result),
    finishReason: normalizeNullableString(value.finishReason),
    errorMessage: normalizeNullableString(value.errorMessage),
    resultSource: normalizeTestResultSource(value.resultSource),
    summaryIssue: normalizeNullableString(value.summaryIssue),
  };
}
