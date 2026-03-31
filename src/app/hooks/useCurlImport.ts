import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { parseCurlCommand } from "../../lib/curl";
import type { K6Options } from "../../lib/loadrift/types";
import type { CurlImportState } from "../types";
import { loadCurlInput, saveCurlInput } from "../persistence";

const INITIAL_CURL_IMPORT_STATE: CurlImportState = {
  status: "idle",
  message: null,
};

export function useCurlImport(
  setRunnerOptions: Dispatch<SetStateAction<K6Options>>,
) {
  const [curlInput, setCurlInput] = useState(() => loadCurlInput(""));
  const [curlImportState, setCurlImportState] = useState<CurlImportState>(
    INITIAL_CURL_IMPORT_STATE,
  );

  useEffect(() => {
    saveCurlInput(curlInput);
  }, [curlInput]);

  function applyCurlCommand() {
    const parsed = parseCurlCommand(curlInput);
    if (!parsed.url && !parsed.authToken) {
      setCurlImportState({
        status: "error",
        message:
          "Could not detect a request URL or bearer/JWT token from that Postman cURL snippet.",
      });
      return;
    }

    setRunnerOptions((previous) => {
      const nextOptions: K6Options = { ...previous };

      if (parsed.authToken) {
        nextOptions.authToken = parsed.authToken;
      } else {
        delete nextOptions.authToken;
      }

      if (parsed.baseUrl) {
        nextOptions.baseUrl = parsed.baseUrl;
      } else {
        delete nextOptions.baseUrl;
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

    setCurlImportState({
      status: "ready",
      message:
        applied.length > 0
          ? `Applied ${applied.join(" and ")} from the pasted Postman cURL snippet.`
          : "Parsed the Postman cURL snippet.",
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
