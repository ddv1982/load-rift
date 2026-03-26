import { useCallback, useEffect, useRef, useState } from "react";
import { useLoadRiftApi } from "../../lib/loadrift/context";
import type { CollectionInfo, K6Options } from "../../lib/loadrift/types";
import { getTauriErrorMessage } from "../../lib/tauri/errors";

export type ConfigValidationStatus = "idle" | "checking" | "ready" | "invalid";

export interface ConfigValidationState {
  status: ConfigValidationStatus;
  message: string | null;
}

interface UseConfigValidationOptions {
  collection: CollectionInfo | null;
  options: K6Options;
  isBusy: boolean;
  isRunning: boolean;
  isStarting: boolean;
}

const INITIAL_STATE: ConfigValidationState = {
  status: "idle",
  message: null,
};

const CHECKING_STATE: ConfigValidationState = {
  status: "checking",
  message: "Validating current configuration...",
};

export function useConfigValidation({
  collection,
  options,
  isBusy,
  isRunning,
  isStarting,
}: UseConfigValidationOptions) {
  const api = useLoadRiftApi();
  const validationRequestId = useRef(0);
  const [state, setState] = useState<ConfigValidationState>(INITIAL_STATE);

  const validateNow = useCallback(
    async (nextOptions: K6Options) => {
      if (!collection) {
        validationRequestId.current += 1;
        setState(INITIAL_STATE);
        return;
      }

      const requestId = validationRequestId.current + 1;
      validationRequestId.current = requestId;
      setState(CHECKING_STATE);

      try {
        const response = await api.validateTestConfiguration({ options: nextOptions });
        if (validationRequestId.current !== requestId) {
          return;
        }

        setState({
          status: response.ready ? "ready" : "invalid",
          message: response.message,
        });
      } catch (error) {
        if (validationRequestId.current !== requestId) {
          return;
        }

        setState({
          status: "invalid",
          message: getTauriErrorMessage(
            error,
            "Failed to validate the current k6 configuration.",
          ),
        });
      }
    },
    [api, collection],
  );

  useEffect(() => {
    if (!collection) {
      validationRequestId.current += 1;
      setState(INITIAL_STATE);
      return;
    }

    validationRequestId.current += 1;
    setState(CHECKING_STATE);

    const timeoutId = window.setTimeout(() => {
      void validateNow(options);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [collection, isBusy, isRunning, isStarting, options, validateNow]);

  return {
    state,
    validateNow,
  };
}
