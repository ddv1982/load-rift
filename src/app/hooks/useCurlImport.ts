import { useState, type Dispatch, type SetStateAction } from "react";
import { parseCurlCommand } from "../../lib/curl";
import type { K6Options } from "../../lib/loadrift/types";
import type { CurlImportState } from "../types";

const INITIAL_CURL_IMPORT_STATE: CurlImportState = {
  status: "idle",
  message: null,
};

export function useCurlImport(
  setRunnerOptions: Dispatch<SetStateAction<K6Options>>,
  runnerOptions: K6Options,
) {
  const [curlInput, setCurlInput] = useState("");
  const [curlImportState, setCurlImportState] = useState<CurlImportState>(
    INITIAL_CURL_IMPORT_STATE,
  );

  function applyCurlCommand() {
    const parsed = parseCurlCommand(curlInput);
    const parsedHeaders = headersForRuntime(parsed.headers, parsed.authToken);
    const headerCount = Object.keys(parsedHeaders).length;
    const bodyTargetRequestId =
      parsed.body && runnerOptions.selectedRequestIds.length === 1
        ? (runnerOptions.selectedRequestIds[0] ?? null)
        : null;

    if (!parsed.url && !parsed.authToken && headerCount === 0 && !parsed.body) {
      setCurlImportState({
        status: "error",
        message:
          "Could not detect request details from that Postman cURL command.",
      });
      return;
    }

    setRunnerOptions((previous) => {
      const nextOptions: K6Options = { ...previous };

      if (parsed.authToken) {
        nextOptions.authToken = parsed.authToken;
      }

      if (parsed.baseUrl) {
        nextOptions.baseUrl = parsed.baseUrl;
      }

      if (headerCount > 0) {
        nextOptions.requestHeaders = mergeHeadersCaseInsensitive(
          previous.requestHeaders ?? {},
          parsedHeaders,
        );
      }

      if (parsed.body && bodyTargetRequestId) {
        nextOptions.requestBodyOverride = {
          requestId: bodyTargetRequestId,
          body: parsed.body.value,
        };
      }

      return nextOptions;
    });

    const applied: string[] = [];
    if (parsed.baseUrl) {
      applied.push(`base URL ${parsed.baseUrl}`);
    }
    if (parsed.authToken) {
      applied.push("bearer token");
    }
    if (headerCount > 0) {
      applied.push(
        `${headerCount} request header${headerCount === 1 ? "" : "s"}`,
      );
    }
    if (parsed.body && bodyTargetRequestId) {
      applied.push("request body override");
    }
    setCurlInput("");
    const bodyNote =
      parsed.body && !bodyTargetRequestId
        ? " A request body was detected but was not applied because exactly one request must be selected first."
        : "";
    setCurlImportState({
      status: "ready",
      message:
        applied.length > 0
          ? `Applied ${formatAppliedList(applied)} from the pasted Postman cURL command. The pasted command was cleared to avoid keeping tokens on screen.${bodyNote}`
          : `Parsed the Postman cURL command. The pasted command was cleared to avoid keeping tokens on screen.${bodyNote}`,
    });
  }

  function handleCurlInputChange(value: string) {
    setCurlInput(value);
    setCurlImportState(INITIAL_CURL_IMPORT_STATE);
  }

  return {
    curlInput,
    curlImportState,
    applyCurlCommand,
    handleCurlInputChange,
  };
}

function headersForRuntime(
  headers: Record<string, string>,
  authToken: string | null,
): Record<string, string> {
  const runtimeHeaders: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (key.trim().toLowerCase() === "authorization" && authToken) {
      continue;
    }

    runtimeHeaders[key] = value;
  }

  return runtimeHeaders;
}

function mergeHeadersCaseInsensitive(
  currentHeaders: Record<string, string>,
  incomingHeaders: Record<string, string>,
): Record<string, string> {
  const merged = { ...currentHeaders };

  for (const [incomingKey, incomingValue] of Object.entries(incomingHeaders)) {
    const existingKey = Object.keys(merged).find(
      (key) => key.toLowerCase() === incomingKey.toLowerCase(),
    );
    if (existingKey) {
      delete merged[existingKey];
    }

    merged[incomingKey] = incomingValue;
  }

  return merged;
}

function formatAppliedList(values: string[]): string {
  if (values.length <= 1) {
    return values[0] ?? "request details";
  }

  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }

  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}
