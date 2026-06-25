import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_K6_OPTIONS,
  type CollectionInfo,
  type K6Options,
} from "../../lib/loadrift/types";
import { getAdvancedOptionsFeedback } from "../advancedOptions";
import {
  createCollectionStorageKey,
  loadCollectionRequestWeights,
  loadRunnerPreferences,
  saveCollectionRequestWeights,
  saveRunnerPreferences,
} from "../persistence";
import {
  getVariableValue,
  isHostVariableKey,
  syncRequestWeights,
  syncSelectedRequestIds,
  syncVariableOverrides,
} from "../utils";

type ThresholdKey = keyof K6Options["thresholds"];

export type ThresholdInputValues = Record<ThresholdKey, string>;
export type ThresholdInputErrors = Partial<Record<ThresholdKey, string>>;

function thresholdValueToInput(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function createThresholdInputs(
  thresholds: K6Options["thresholds"],
): ThresholdInputValues {
  return {
    p95ResponseTime: thresholdValueToInput(thresholds.p95ResponseTime),
    errorRate: thresholdValueToInput(thresholds.errorRate),
  };
}

function validateThresholdInput(
  key: ThresholdKey,
  value: string,
): string | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  if (!/^\d+$/.test(trimmedValue)) {
    return key === "errorRate"
      ? "Error-rate threshold must be a whole percentage from 0 to 100."
      : "P95 threshold must be a whole number of milliseconds.";
  }

  if (key === "errorRate" && Number(trimmedValue) > 100) {
    return "Error-rate threshold must be a whole percentage from 0 to 100.";
  }

  return null;
}

function validateVusInput(value: string): string | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return "Virtual users is required.";
  }

  const parsedValue = Number(trimmedValue);
  if (
    !/^\d+$/.test(trimmedValue) ||
    !Number.isFinite(parsedValue) ||
    !Number.isSafeInteger(parsedValue) ||
    parsedValue < 1
  ) {
    return "Virtual users must be a whole number of 1 or more.";
  }

  return null;
}

export function useRunnerOptions(collection: CollectionInfo | null) {
  const collectionKey = useMemo(
    () => (collection ? createCollectionStorageKey(collection) : null),
    [collection],
  );
  const pendingRequestWeightCollectionKey = useRef<string | null>(null);
  const [runnerOptions, setRunnerOptions] = useState<K6Options>(() =>
    loadRunnerPreferences(DEFAULT_K6_OPTIONS),
  );
  const [thresholdInputs, setThresholdInputs] = useState<ThresholdInputValues>(
    () => createThresholdInputs(runnerOptions.thresholds),
  );
  const [thresholdErrors, setThresholdErrors] = useState<ThresholdInputErrors>(
    {},
  );
  const [vusInput, setVusInput] = useState(() => String(runnerOptions.vus));
  const [vusError, setVusError] = useState<string | null>(() =>
    validateVusInput(String(runnerOptions.vus)),
  );

  useEffect(() => {
    const persistedRequestWeights = collectionKey
      ? (loadCollectionRequestWeights(collectionKey) ?? {})
      : {};

    pendingRequestWeightCollectionKey.current = collectionKey;

    setRunnerOptions((previous) => ({
      ...previous,
      selectedRequestIds: syncSelectedRequestIds(
        collection?.requests ?? [],
        previous.selectedRequestIds,
      ),
      requestWeights: syncRequestWeights(
        collection?.requests ?? [],
        persistedRequestWeights,
      ),
      variableOverrides: syncVariableOverrides(
        collection?.runtimeVariables ?? [],
        previous.variableOverrides,
      ),
    }));
  }, [collection, collectionKey]);

  useEffect(() => {
    saveRunnerPreferences(runnerOptions);
  }, [runnerOptions]);

  useEffect(() => {
    if (!collectionKey) {
      return;
    }

    if (pendingRequestWeightCollectionKey.current === collectionKey) {
      pendingRequestWeightCollectionKey.current = null;
      return;
    }

    saveCollectionRequestWeights(collectionKey, runnerOptions.requestWeights);
  }, [collectionKey, runnerOptions.requestWeights]);

  const emptyRuntimeVariables = useMemo(
    () =>
      (collection?.runtimeVariables ?? []).filter((variable) => {
        if (runnerOptions.baseUrl?.trim() && isHostVariableKey(variable.key)) {
          return false;
        }

        return !getVariableValue(
          variable,
          runnerOptions.variableOverrides,
        ).trim();
      }),
    [collection, runnerOptions.baseUrl, runnerOptions.variableOverrides],
  );

  function updateRunnerOption<K extends keyof K6Options>(
    key: K,
    value: K6Options[K],
  ) {
    setRunnerOptions((previous) => ({
      ...previous,
      [key]: value,
    }));
  }

  function updateThreshold(key: ThresholdKey, value: string) {
    const error = validateThresholdInput(key, value);

    setThresholdInputs((previous) => ({
      ...previous,
      [key]: value,
    }));
    setThresholdErrors((previous) => {
      const next = { ...previous };
      if (error) {
        next[key] = error;
      } else {
        delete next[key];
      }
      return next;
    });

    if (error) {
      return;
    }

    setRunnerOptions((previous) => ({
      ...previous,
      thresholds: {
        ...previous.thresholds,
        [key]: value.trim() ? Number(value) : undefined,
      },
    }));
  }

  function updateVusInput(value: string) {
    const error = validateVusInput(value);
    setVusInput(value);
    setVusError(error);

    if (error) {
      return;
    }

    setRunnerOptions((previous) => ({
      ...previous,
      vus: Number(value.trim()),
    }));
  }

  function updateRuntimeVariable(key: string, value: string) {
    setRunnerOptions((previous) => ({
      ...previous,
      variableOverrides: {
        ...previous.variableOverrides,
        [key]: value,
      },
    }));
  }

  function updateSelectedRequestIds(selectedRequestIds: string[]) {
    setRunnerOptions((previous) => ({
      ...previous,
      selectedRequestIds,
    }));
  }

  function updateRequestWeight(requestId: string, weight: number) {
    setRunnerOptions((previous) => ({
      ...previous,
      requestWeights: {
        ...previous.requestWeights,
        [requestId]: Number.isFinite(weight)
          ? Math.max(0, Math.trunc(weight))
          : 1,
      },
    }));
  }

  const advancedOptionsFeedback = useMemo(
    () => getAdvancedOptionsFeedback(runnerOptions.advancedOptionsJson ?? ""),
    [runnerOptions.advancedOptionsJson],
  );
  const advancedOptionsError =
    advancedOptionsFeedback?.tone === "error"
      ? advancedOptionsFeedback.message
      : null;
  // Invalid advanced JSON blocks local readiness so field feedback, Check Config,
  // and Start Test stay semantically aligned.
  const runnerOptionsAreValid =
    !vusError &&
    Object.keys(thresholdErrors).length === 0 &&
    !advancedOptionsError;

  return {
    runnerOptions,
    setRunnerOptions,
    emptyRuntimeVariables,
    thresholdInputs,
    thresholdErrors,
    vusInput,
    vusError,
    runnerOptionsAreValid,
    advancedOptionsFeedback,
    updateRunnerOption,
    updateThreshold,
    updateVusInput,
    updateRuntimeVariable,
    updateSelectedRequestIds,
    updateRequestWeight,
  };
}
