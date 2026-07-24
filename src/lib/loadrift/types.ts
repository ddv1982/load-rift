export type TestStatus =
  "idle" | "running" | "completed" | "failed" | "stopped";

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function invalidNativeResponse(name: string): never {
  throw new TypeError(`Invalid ${name} response from the native runtime.`);
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeTestStatus(value: unknown): TestStatus | null {
  return value === "idle" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped"
    ? value
    : null;
}

function normalizeCompletionStatus(value: unknown): TestStatus | null {
  return value === "completed" || value === "failed" || value === "stopped"
    ? value
    : null;
}

function normalizeTestResultStatus(value: unknown): TestResultStatus | null {
  return value === "passed" || value === "warning" || value === "failed"
    ? value
    : null;
}

function normalizeTestResultSource(value: unknown): TestResultSource | null {
  return value === "summary" || value === "liveMetricsFallback" ? value : null;
}

function normalizeTestMetrics(value: Record<string, unknown>): TestMetrics {
  return {
    totalRequests: normalizeNumber(value.totalRequests, 0),
    failedRequests: normalizeNumber(value.failedRequests, 0),
    avgResponseTime: normalizeNumber(value.avgResponseTime, 0),
    p50ResponseTime: normalizeNumber(value.p50ResponseTime, 0),
    p95ResponseTime: normalizeNumber(value.p95ResponseTime, 0),
    maxResponseTime: normalizeNumber(value.maxResponseTime, 0),
    requestsPerSecond: normalizeNumber(value.requestsPerSecond, 0),
  };
}

function normalizeThresholdResult(value: unknown): ThresholdResult | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    !isNonEmptyString(value.name) ||
    typeof value.passed !== "boolean" ||
    typeof value.actual !== "number" ||
    typeof value.threshold !== "number"
  ) {
    return null;
  }

  return {
    name: value.name,
    passed: value.passed,
    actual: normalizeNumber(value.actual, 0),
    threshold: normalizeNumber(value.threshold, 0),
  };
}

function normalizeRequestInfo(value: unknown): RequestInfo | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    typeof value.name !== "string" ||
    typeof value.method !== "string" ||
    typeof value.url !== "string" ||
    !Array.isArray(value.folderPath) ||
    !value.folderPath.every((entry) => typeof entry === "string")
  ) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    method: value.method,
    url: value.url,
    folderPath: value.folderPath,
  };
}

function normalizeRuntimeVariable(value: unknown): RuntimeVariable | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.key) ||
    (value.defaultValue !== undefined &&
      value.defaultValue !== null &&
      typeof value.defaultValue !== "string")
  ) {
    return null;
  }

  return value.defaultValue === undefined || value.defaultValue === null
    ? { key: value.key }
    : { key: value.key, defaultValue: value.defaultValue };
}

export function normalizeCollectionInfo(value: unknown): CollectionInfo | null {
  if (value === null) {
    return null;
  }

  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !isNonNegativeInteger(value.requestCount) ||
    !isNonNegativeInteger(value.folderCount) ||
    !Array.isArray(value.requests) ||
    !Array.isArray(value.runtimeVariables)
  ) {
    return invalidNativeResponse("collection import");
  }

  const requests = value.requests.map(normalizeRequestInfo);
  const runtimeVariables = value.runtimeVariables.map(normalizeRuntimeVariable);
  if (
    requests.some((request) => request === null) ||
    runtimeVariables.some((variable) => variable === null) ||
    value.requestCount !== requests.length ||
    requests.length === 0
  ) {
    return invalidNativeResponse("collection import");
  }

  const requestIds = new Set(requests.map((request) => request?.id));
  const runtimeVariableKeys = new Set(
    runtimeVariables.map((variable) => variable?.key),
  );
  if (
    requestIds.size !== requests.length ||
    runtimeVariableKeys.size !== runtimeVariables.length
  ) {
    return invalidNativeResponse("collection import");
  }

  return {
    name: value.name,
    requestCount: value.requestCount,
    folderCount: value.folderCount,
    requests: requests as RequestInfo[],
    runtimeVariables: runtimeVariables as RuntimeVariable[],
  };
}

export function normalizeValidateTestConfigurationResponse(
  value: unknown,
): ValidateTestConfigurationResponse {
  if (
    !isRecord(value) ||
    typeof value.ready !== "boolean" ||
    !isNullableString(value.message)
  ) {
    return invalidNativeResponse("test validation");
  }

  return { ready: value.ready, message: value.message };
}

function normalizeStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }

  const entries = Object.entries(value);
  return entries.every(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  )
    ? Object.fromEntries(entries)
    : null;
}

function normalizeSmokeTestResult(value: unknown): SmokeTestResult | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.requestId) ||
    typeof value.requestName !== "string" ||
    typeof value.method !== "string" ||
    typeof value.url !== "string" ||
    !(
      value.statusCode === null ||
      (isNonNegativeInteger(value.statusCode) && value.statusCode <= 65_535)
    ) ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    typeof value.ok !== "boolean" ||
    !isNullableString(value.contentType) ||
    !isNullableString(value.bodyPreview) ||
    !isNullableString(value.errorMessage)
  ) {
    return null;
  }

  const responseHeaders = normalizeStringRecord(value.responseHeaders);
  const statusCode =
    typeof value.statusCode === "number" ? value.statusCode : null;
  const hasHttpResponse = statusCode !== null;
  const expectedOk = hasHttpResponse && statusCode >= 200 && statusCode < 400;
  if (
    !responseHeaders ||
    value.ok !== expectedOk ||
    (hasHttpResponse
      ? value.errorMessage !== null
      : !isNonEmptyString(value.errorMessage))
  ) {
    return null;
  }

  return {
    requestId: value.requestId,
    requestName: value.requestName,
    method: value.method,
    url: value.url,
    statusCode,
    durationMs: value.durationMs,
    ok: value.ok,
    contentType: value.contentType,
    responseHeaders,
    bodyPreview: value.bodyPreview,
    errorMessage: value.errorMessage,
  };
}

export function normalizeSmokeTestResponse(value: unknown): SmokeTestResponse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.responses) ||
    value.responses.length === 0
  ) {
    return invalidNativeResponse("smoke test");
  }

  const responses = value.responses.map(normalizeSmokeTestResult);
  if (responses.some((response) => response === null)) {
    return invalidNativeResponse("smoke test");
  }

  const requestIds = new Set(responses.map((response) => response?.requestId));
  if (requestIds.size !== responses.length) {
    return invalidNativeResponse("smoke test");
  }

  return { responses: responses as SmokeTestResult[] };
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
  if (
    !isRecord(value) ||
    !isRecord(value.metrics) ||
    !Array.isArray(value.thresholds)
  ) {
    return null;
  }

  const status = normalizeTestResultStatus(value.status);
  const thresholds = value.thresholds.map(normalizeThresholdResult);
  if (!status || thresholds.some((threshold) => threshold === null)) {
    return null;
  }

  return {
    status,
    metrics: normalizeTestMetrics(value.metrics),
    thresholds: thresholds as ThresholdResult[],
  };
}

export function normalizeRunMetricsEvent(
  value: unknown,
): RunMetricsEvent | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.runId) ||
    !isRecord(value.metrics)
  ) {
    return null;
  }

  return {
    runId: value.runId,
    metrics: normalizeLiveMetrics(value.metrics),
  };
}

export function normalizeRunErrorEvent(value: unknown): RunErrorEvent | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.runId) ||
    !isNonEmptyString(value.message)
  ) {
    return null;
  }

  return {
    runId: value.runId,
    message: value.message,
  };
}

export function normalizeStartTestResponse(
  value: unknown,
  fallbackRunId: string,
): StartTestResponse {
  if (isNonEmptyString(fallbackRunId)) {
    return { runId: fallbackRunId };
  }

  if (!isRecord(value) || !isNonEmptyString(value.runId)) {
    return invalidNativeResponse("test start");
  }

  return { runId: value.runId };
}

export function normalizeTestCompletion(value: unknown): TestCompletion | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.runId) ||
    !isNonEmptyString(value.finishReason) ||
    !isRecord(value.metrics) ||
    !isNullableNonEmptyString(value.summaryIssue) ||
    !isNullableNonEmptyString(value.errorMessage)
  ) {
    return null;
  }

  const runState = normalizeCompletionStatus(value.runState);
  const result = normalizeTestResult(value.result);
  const resultSource = normalizeTestResultSource(value.resultSource);
  const lifecycleIsCoherent =
    (runState === "completed" &&
      value.errorMessage === null &&
      (value.finishReason === "completed" ||
        (value.finishReason === "thresholds_failed" &&
          result?.status === "failed"))) ||
    (runState === "failed" &&
      value.finishReason === "execution_error" &&
      isNonEmptyString(value.errorMessage) &&
      result?.status === "failed") ||
    (runState === "stopped" &&
      value.finishReason === "stopped" &&
      value.errorMessage === null);
  if (!runState || !result || !resultSource || !lifecycleIsCoherent) {
    return null;
  }

  return {
    runId: value.runId,
    runState,
    finishReason: value.finishReason,
    metrics: normalizeLiveMetrics(value.metrics),
    result,
    resultSource,
    summaryIssue: value.summaryIssue,
    errorMessage: value.errorMessage,
  };
}

export function normalizeGetTestStatusResponse(
  value: unknown,
): GetTestStatusResponse {
  if (
    !isRecord(value) ||
    typeof value.isRunning !== "boolean" ||
    !(value.runId === null || isNonEmptyString(value.runId)) ||
    !(value.metrics === null || isRecord(value.metrics)) ||
    !isNullableNonEmptyString(value.finishReason) ||
    !isNullableNonEmptyString(value.errorMessage) ||
    !isNullableNonEmptyString(value.summaryIssue)
  ) {
    return invalidNativeResponse("test status");
  }

  const status = normalizeTestStatus(value.status);
  const result =
    value.result === null ? null : normalizeTestResult(value.result);
  const resultSource = normalizeTestResultSource(value.resultSource);
  if (
    !status ||
    (value.result !== null && !result) ||
    (value.resultSource !== null && !resultSource) ||
    (resultSource !== null && result === null)
  ) {
    return invalidNativeResponse("test status");
  }

  const hasRunId = value.runId !== null;
  const isIdle = status === "idle";
  const isRunning = status === "running";
  const completedStatusIsCoherent =
    status !== "completed" ||
    (value.metrics !== null &&
      result !== null &&
      resultSource !== null &&
      value.errorMessage === null &&
      (value.finishReason === "completed" ||
        (value.finishReason === "thresholds_failed" &&
          result.status === "failed")));
  if (
    value.isRunning !== isRunning ||
    (isIdle && hasRunId) ||
    (!isIdle && !hasRunId) ||
    ((isIdle || isRunning) &&
      (value.result !== null ||
        value.finishReason !== null ||
        value.errorMessage !== null ||
        value.resultSource !== null ||
        value.summaryIssue !== null)) ||
    !completedStatusIsCoherent
  ) {
    return invalidNativeResponse("test status");
  }

  return {
    runId: value.runId,
    status,
    isRunning: value.isRunning,
    metrics:
      value.metrics === null ? null : normalizeLiveMetrics(value.metrics),
    result,
    finishReason: value.finishReason,
    errorMessage: value.errorMessage,
    resultSource,
    summaryIssue: value.summaryIssue,
  };
}
