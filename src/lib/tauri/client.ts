import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { LoadRiftApi } from "../loadrift/api";
import {
  K6_COMPLETE_EVENT,
  K6_ERROR_EVENT,
  K6_METRICS_EVENT,
  K6_OUTPUT_EVENT,
} from "../loadrift/api";
import type {
  CollectionInfo,
  GetTestStatusResponse,
  K6Options,
  LiveMetrics,
  TestCompletion,
  ValidateTestConfigurationResponse,
} from "../loadrift/types";

function command<TResponse>(
  name: string,
  args?: Record<string, unknown>,
): Promise<TResponse> {
  return invoke<TResponse>(name, args);
}

async function listenScoped<TPayload>(
  event: string,
  callback: (payload: TPayload) => void,
): Promise<UnlistenFn> {
  const window = getCurrentWebviewWindow();

  return window.listen<TPayload>(event, (eventPayload) => {
    callback(eventPayload.payload);
  });
}

export function createTauriLoadRiftApi(): LoadRiftApi {
  return {
    importCollectionFromFile(input: { filePath: string }) {
      return command<CollectionInfo>("import_collection_from_file", {
        request: input,
      });
    },
    importCollectionFromUrl(input: { url: string }) {
      return command<CollectionInfo>("import_collection_from_url", {
        request: input,
      });
    },
    validateTestConfiguration(input: { options: K6Options }) {
      return command<ValidateTestConfigurationResponse>(
        "validate_test_configuration",
        {
          request: input,
        },
      );
    },
    startTest(input: { options: K6Options }) {
      return command<void>("start_test", {
        request: input,
      });
    },
    stopTest() {
      return command<void>("stop_test");
    },
    exportReport(input: { savePath: string }) {
      return command<void>("export_report", {
        request: input,
      });
    },
    getTestStatus() {
      return command<GetTestStatusResponse>("get_test_status");
    },
    onK6Output(callback: (payload: string) => void) {
      return listenScoped<string>(K6_OUTPUT_EVENT, callback);
    },
    onK6Metrics(callback: (payload: LiveMetrics) => void) {
      return listenScoped<LiveMetrics>(K6_METRICS_EVENT, callback);
    },
    onK6Complete(callback: (payload: TestCompletion) => void) {
      return listenScoped<TestCompletion>(K6_COMPLETE_EVENT, callback);
    },
    onK6Error(callback: (payload: string) => void) {
      return listenScoped<string>(K6_ERROR_EVENT, callback);
    },
  };
}
