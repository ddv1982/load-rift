import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_K6_OPTIONS,
  type CollectionInfo,
  type K6Options,
} from "../../lib/loadrift/types";
import { loadRunnerPreferences, saveRunnerPreferences } from "../persistence";
import {
  getVariableValue,
  isHostVariableKey,
  syncSelectedRequestIds,
  syncVariableOverrides,
} from "../utils";

export function useRunnerOptions(collection: CollectionInfo | null) {
  const [runnerOptions, setRunnerOptions] = useState<K6Options>(() =>
    loadRunnerPreferences(DEFAULT_K6_OPTIONS),
  );

  useEffect(() => {
    setRunnerOptions((previous) => ({
      ...previous,
      selectedRequestIds: syncSelectedRequestIds(
        collection?.requests ?? [],
        previous.selectedRequestIds,
      ),
      variableOverrides: syncVariableOverrides(
        collection?.runtimeVariables ?? [],
        previous.variableOverrides,
      ),
    }));
  }, [collection]);

  useEffect(() => {
    saveRunnerPreferences(runnerOptions);
  }, [runnerOptions]);

  const emptyRuntimeVariables = useMemo(
    () =>
      (collection?.runtimeVariables ?? []).filter((variable) => {
        if (runnerOptions.baseUrl?.trim() && isHostVariableKey(variable.key)) {
          return false;
        }

        return !getVariableValue(variable, runnerOptions.variableOverrides).trim();
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

  function updateThreshold(
    key: keyof K6Options["thresholds"],
    value: string,
  ) {
    setRunnerOptions((previous) => ({
      ...previous,
      thresholds: {
        ...previous.thresholds,
        [key]: value.trim() ? Number(value) : undefined,
      },
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

  return {
    runnerOptions,
    setRunnerOptions,
    emptyRuntimeVariables,
    updateRunnerOption,
    updateThreshold,
    updateRuntimeVariable,
    updateSelectedRequestIds,
  };
}
