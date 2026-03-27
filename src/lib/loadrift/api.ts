import type {
  CollectionInfo,
  GetTestStatusResponse,
  K6Options,
  LiveMetrics,
  TestCompletion,
  ValidateTestConfigurationResponse,
} from "./types";

export const K6_OUTPUT_EVENT = "k6:output";
export const K6_METRICS_EVENT = "k6:metrics";
export const K6_COMPLETE_EVENT = "k6:complete";
export const K6_ERROR_EVENT = "k6:error";

export interface LoadRiftApi {
  importCollectionFromFile(input: { filePath: string }): Promise<CollectionInfo>;
  validateTestConfiguration(input: {
    options: K6Options;
  }): Promise<ValidateTestConfigurationResponse>;
  startTest(input: { options: K6Options }): Promise<void>;
  stopTest(): Promise<void>;
  exportReport(input: { savePath: string }): Promise<void>;
  getTestStatus(): Promise<GetTestStatusResponse>;
  onK6Output(callback: (payload: string) => void): Promise<() => void>;
  onK6Metrics(callback: (payload: LiveMetrics) => void): Promise<() => void>;
  onK6Complete(callback: (payload: TestCompletion) => void): Promise<() => void>;
  onK6Error(callback: (payload: string) => void): Promise<() => void>;
}
