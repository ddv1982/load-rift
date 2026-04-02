import type {
  CollectionInfo,
  K6Options,
  RuntimeVariable,
} from "../../lib/loadrift/types";
import {
  formatVariableLabel,
  getVariableValue,
  isHostVariableKey,
} from "../utils";
import { SettingsCardHeader } from "./SettingsCardHeader";

interface RuntimeVariablesCardProps {
  collection: CollectionInfo | null;
  runnerOptions: K6Options;
  emptyRuntimeVariables: RuntimeVariable[];
  onRuntimeVariableChange: (key: string, value: string) => void;
}

export function RuntimeVariablesCard({
  collection,
  runnerOptions,
  emptyRuntimeVariables,
  onRuntimeVariableChange,
}: RuntimeVariablesCardProps) {
  return (
    <div className="settings-card">
      <SettingsCardHeader
        eyebrow="Runtime Variables"
        title="Collection Overrides"
        hint='Detected from `{{...}}` placeholders in the imported collection. Host-style variables will use the derived base URL from the Postman cURL snippet when one is available.'
      />

      {collection?.runtimeVariables.length ? (
        <div className="settings-grid">
          {collection.runtimeVariables.map((variable) => {
            const isHostVariable = isHostVariableKey(variable.key);

            return (
              <label key={variable.key} className="field">
                <span>{formatVariableLabel(variable.key)}</span>
                <input
                  type="text"
                  value={
                    isHostVariable
                      ? runnerOptions.baseUrl ?? ""
                      : getVariableValue(variable, runnerOptions.variableOverrides)
                  }
                  onChange={(event) => {
                    if (isHostVariable) {
                      return;
                    }

                    onRuntimeVariableChange(variable.key, event.target.value);
                  }}
                  placeholder={
                    isHostVariable
                      ? "Apply a Postman cURL snippet to derive this value."
                      : variable.defaultValue ?? `Set ${variable.key}`
                  }
                  readOnly={isHostVariable}
                />
              </label>
            );
          })}
        </div>
      ) : (
        <p className="panel-copy">
          No `{"{{...}}"}` placeholders were detected in this collection.
        </p>
      )}

      {emptyRuntimeVariables.length ? (
        <p className="panel-copy">
          Empty variables:{" "}
          {emptyRuntimeVariables.map((variable) => variable.key).join(", ")}.
          The backend will validate whether these are truly required when you
          start the test.
        </p>
      ) : null}
    </div>
  );
}
