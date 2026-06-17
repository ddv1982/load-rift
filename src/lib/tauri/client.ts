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
  K6Options,
  RunErrorEvent,
  RunMetricsEvent,
  SmokeTestResponse,
  TestCompletion,
  ValidateTestConfigurationResponse,
} from "../loadrift/types";
import {
  normalizeGetTestStatusResponse,
  normalizeRunErrorEvent,
  normalizeRunMetricsEvent,
  normalizeStartTestResponse,
  normalizeTestCompletion,
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
    validateTestConfiguration(input: { options: K6Options }) {
      return command<ValidateTestConfigurationResponse>(
        "validate_test_configuration",
        {
          request: input,
        },
      );
    },
    smokeTestRequests(input: { options: K6Options }) {
      return command<SmokeTestResponse>("smoke_test_requests", {
        request: input,
      });
    },
    startTest(input: { options: K6Options; runId?: string }) {
      return command<unknown>("start_test", {
        request: input,
      }).then((response) => normalizeStartTestResponse(response, input.runId ?? ""));
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
      return command<unknown>("get_test_status").then(normalizeGetTestStatusResponse);
    },
    onK6Output(callback: (payload: string) => void) {
      return listenScoped<unknown>(K6_OUTPUT_EVENT, (payload) => {
        if (typeof payload === "string") {
          callback(payload);
        }
      });
    },
    onK6Metrics(callback: (payload: RunMetricsEvent) => void) {
      return listenScoped<unknown>(K6_METRICS_EVENT, (payload) => {
        const event = normalizeRunMetricsEvent(payload);
        if (event) {
          callback(event);
        }
      });
    },
    onK6Complete(callback: (payload: TestCompletion) => void) {
      return listenScoped<unknown>(K6_COMPLETE_EVENT, (payload) => {
        const completion = normalizeTestCompletion(payload);
        if (completion) {
          callback(completion);
        }
      });
    },
    onK6Error(callback: (payload: RunErrorEvent) => void) {
      return listenScoped<unknown>(K6_ERROR_EVENT, (payload) => {
        const event = normalizeRunErrorEvent(payload);
        if (event) {
          callback(event);
        }
      });
    },
  };
}
