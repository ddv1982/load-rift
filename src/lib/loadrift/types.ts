export type TestStatus = "idle" | "running" | "completed" | "failed" | "stopped";

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
  variableOverrides: Record<string, string>;
  advancedOptionsJson?: string;
  selectedRequestIds: string[];
  trafficMode: TrafficMode;
  requestWeights: Record<string, number>;
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

export interface TestCompletion {
  runState: TestStatus;
  finishReason: string;
  metrics: LiveMetrics;
  result: TestResult;
}

export interface GetTestStatusResponse {
  status: TestStatus;
  isRunning: boolean;
  metrics: LiveMetrics | null;
  result: TestResult | null;
  finishReason: string | null;
  errorMessage: string | null;
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
