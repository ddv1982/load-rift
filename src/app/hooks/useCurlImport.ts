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
) {
  const [curlInput, setCurlInput] = useState("");
  const [curlImportState, setCurlImportState] = useState<CurlImportState>(
    INITIAL_CURL_IMPORT_STATE,
  );

  function applyCurlCommand() {
    const parsed = parseCurlCommand(curlInput);
    if (!parsed.url && !parsed.authToken) {
      setCurlImportState({
        status: "error",
        message:
          "Could not detect a request URL or bearer/JWT token from that Postman cURL command.",
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

      return nextOptions;
    });

    const applied: string[] = [];
    if (parsed.baseUrl) {
      applied.push(`base URL ${parsed.baseUrl}`);
    }
    if (parsed.authToken) {
      applied.push("bearer token");
    }

    setCurlInput("");
    setCurlImportState({
      status: "ready",
      message:
        applied.length > 0
          ? `Extracted ${applied.join(" and ")} from the pasted Postman cURL command. The pasted command was cleared to avoid keeping tokens on screen.`
          : "Parsed the Postman cURL command. The pasted command was cleared to avoid keeping tokens on screen.",
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
