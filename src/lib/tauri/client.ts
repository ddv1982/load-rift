import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { ExportReportResponse, LoadRiftApi } from "../loadrift/api";
import {
  K6_COMPLETE_EVENT,
  K6_ERROR_EVENT,
  K6_METRICS_EVENT,
  K6_OUTPUT_EVENT,
} from "../loadrift/api";
import type {
  K6Options,
  RunErrorEvent,
  RunMetricsEvent,
  TestCompletion,
} from "../loadrift/types";
import {
  normalizeCollectionInfo,
  normalizeGetTestStatusResponse,
  normalizeRunErrorEvent,
  normalizeRunMetricsEvent,
  normalizeSmokeTestResponse,
  normalizeStartTestResponse,
  normalizeTestCompletion,
  normalizeValidateTestConfigurationResponse,
} from "../loadrift/types";

function command(
  name: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  return invoke<unknown>(name, args);
}

function normalizeExportReportResponse(
  value: unknown,
): ExportReportResponse | null {
  if (value === null) {
    return null;
  }

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("savePath" in value) ||
    typeof value.savePath !== "string" ||
    value.savePath.trim().length === 0
  ) {
    throw new TypeError(
      "Invalid report export response from the native runtime.",
    );
  }

  return { savePath: value.savePath };
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
    selectAndImportCollection() {
      return command("select_and_import_collection").then(
        normalizeCollectionInfo,
      );
    },
    validateTestConfiguration(input: { options: K6Options }) {
      return command("validate_test_configuration", {
        request: input,
      }).then(normalizeValidateTestConfigurationResponse);
    },
    smokeTestRequests(input: { options: K6Options }) {
      return command("smoke_test_requests", {
        request: input,
      }).then(normalizeSmokeTestResponse);
    },
    startTest(input: { options: K6Options; runId?: string }) {
      return command("start_test", {
        request: input,
      }).then((response) =>
        normalizeStartTestResponse(response, input.runId ?? ""),
      );
    },
    stopTest() {
      return command("stop_test").then(() => undefined);
    },
    selectAndExportReport(input: { defaultPath: string }) {
      return command("select_and_export_report", {
        request: input,
      }).then(normalizeExportReportResponse);
    },
    getTestStatus() {
      return command("get_test_status").then(normalizeGetTestStatusResponse);
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
