import { useEffect, useId, useRef, useState } from "react";
import type { K6Options } from "../../lib/loadrift/types";
import type {
  ThresholdInputErrors,
  ThresholdInputValues,
} from "../hooks/useRunnerOptions";
import type { CurlImportState } from "../types";
import { SettingsCardHeader } from "./SettingsCardHeader";

const EMPTY_REQUEST_HEADERS: Record<string, string> = {};

interface RunnerSettingsCardProps {
  runnerOptions: K6Options;
  thresholdInputs: ThresholdInputValues;
  thresholdErrors: ThresholdInputErrors;
  vusInput: string;
  vusError: string | null;
  curlInput: string;
  curlImportState: CurlImportState;
  onVusChange: (value: string) => void;
  onDurationChange: (value: string) => void;
  onRampUpChange: (value: K6Options["rampUp"]) => void;
  onRampUpTimeChange: (value: string) => void;
  onThresholdChange: (
    key: keyof K6Options["thresholds"],
    value: string,
  ) => void;
  onTrafficModeChange: (value: K6Options["trafficMode"]) => void;
  onAuthTokenChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onRequestHeadersChange: (value: Record<string, string>) => void;
  onRequestBodyOverrideChange: (
    value: K6Options["requestBodyOverride"],
  ) => void;
  onCurlInputChange: (value: string) => void;
  onApplyCurlCommand: () => void;
}

export function RunnerSettingsCard({
  runnerOptions,
  thresholdInputs,
  thresholdErrors,
  vusInput,
  vusError,
  curlInput,
  curlImportState,
  onVusChange,
  onDurationChange,
  onRampUpChange,
  onRampUpTimeChange,
  onThresholdChange,
  onTrafficModeChange,
  onAuthTokenChange,
  onBaseUrlChange,
  onRequestHeadersChange,
  onRequestBodyOverrideChange,
  onCurlInputChange,
  onApplyCurlCommand,
}: RunnerSettingsCardProps) {
  const vusErrorId = useId();
  const p95ThresholdErrorId = useId();
  const errorRateThresholdErrorId = useId();
  const curlImportStatusId = useId();
  const requestHeaders = runnerOptions.requestHeaders ?? EMPTY_REQUEST_HEADERS;
  const requestHeaderRowIdPrefix = useId();
  const [requestHeaderRows, setRequestHeaderRows] = useState(() =>
    Object.keys(requestHeaders).map((key, index) => ({
      key,
      rowId: `${requestHeaderRowIdPrefix}-request-header-${index + 1}`,
    })),
  );
  const nextRequestHeaderRowId = useRef(requestHeaderRows.length);
  const [requestHeaderNameErrors, setRequestHeaderNameErrors] = useState<
    Record<string, string>
  >({});
  const requestHeaderEntries = requestHeaderRows.flatMap(({ key, rowId }) =>
    Object.prototype.hasOwnProperty.call(requestHeaders, key)
      ? [{ key, value: requestHeaders[key] ?? "", rowId }]
      : [],
  );
  const requestBodyOverride = runnerOptions.requestBodyOverride;

  useEffect(() => {
    const keys = Object.keys(requestHeaders);
    setRequestHeaderNameErrors((current) =>
      Object.keys(current).length > 0 ? {} : current,
    );
    setRequestHeaderRows((current) => {
      if (
        current.length === keys.length &&
        current.every((row, index) => row.key === keys[index])
      ) {
        return current;
      }

      const currentByKey = new Map(current.map((row) => [row.key, row]));
      return keys.map((key) => {
        const existingRow = currentByKey.get(key);
        if (existingRow) {
          return existingRow;
        }

        nextRequestHeaderRowId.current += 1;
        return {
          key,
          rowId: `${requestHeaderRowIdPrefix}-request-header-${nextRequestHeaderRowId.current}`,
        };
      });
    });
  }, [requestHeaderRowIdPrefix, requestHeaders]);

  function handleAddRequestHeader() {
    onRequestHeadersChange({
      ...requestHeaders,
      [nextHeaderKey(requestHeaders)]: "",
    });
  }

  function handleRequestHeaderKeyChange(previousKey: string, nextKey: string) {
    const row = requestHeaderRows.find(
      (candidate) => candidate.key === previousKey,
    );
    if (!row) {
      return;
    }
    const { rowId } = row;

    if (!nextKey.trim()) {
      setRequestHeaderNameErrors((current) => ({
        ...current,
        [rowId]: "Header name is required.",
      }));
      return;
    }

    const nextHeaders: Record<string, string> = {};
    const nextKeyAlreadyExists = Object.keys(requestHeaders).some(
      (key) =>
        key !== previousKey && key.toLowerCase() === nextKey.toLowerCase(),
    );

    if (nextKeyAlreadyExists) {
      setRequestHeaderNameErrors((current) => ({
        ...current,
        [rowId]: `A request header named "${nextKey}" already exists.`,
      }));
      return;
    }

    setRequestHeaderNameErrors((current) => {
      if (!(rowId in current)) {
        return current;
      }

      const nextErrors = { ...current };
      delete nextErrors[rowId];
      return nextErrors;
    });
    setRequestHeaderRows((current) =>
      current.map((candidate) =>
        candidate.rowId === rowId ? { ...candidate, key: nextKey } : candidate,
      ),
    );

    for (const [key, value] of Object.entries(requestHeaders)) {
      if (key === previousKey) {
        nextHeaders[nextKey] = value;
      } else {
        nextHeaders[key] = value;
      }
    }

    onRequestHeadersChange(nextHeaders);
  }

  function handleRequestHeaderValueChange(key: string, value: string) {
    onRequestHeadersChange({
      ...requestHeaders,
      [key]: value,
    });
  }

  function handleRemoveRequestHeader(keyToRemove: string) {
    const rowId = requestHeaderRows.find(
      (candidate) => candidate.key === keyToRemove,
    )?.rowId;
    if (rowId) {
      setRequestHeaderRows((current) =>
        current.filter((candidate) => candidate.rowId !== rowId),
      );
      setRequestHeaderNameErrors((current) => {
        if (!(rowId in current)) {
          return current;
        }

        const nextErrors = { ...current };
        delete nextErrors[rowId];
        return nextErrors;
      });
    }

    const nextHeaders = { ...requestHeaders };
    delete nextHeaders[keyToRemove];
    onRequestHeadersChange(nextHeaders);
  }

  return (
    <div className="settings-card">
      <SettingsCardHeader
        eyebrow="Runner Settings"
        title="Basic k6 Controls"
        hint="Set the common load profile. Use advanced JSON for scenarios and tags."
      />

      <div className="settings-grid">
        <label className="field">
          <span>Virtual users</span>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={vusInput}
            aria-label="Virtual users"
            onChange={(event) => onVusChange(event.target.value)}
            aria-invalid={vusError ? "true" : undefined}
            aria-describedby={vusError ? vusErrorId : undefined}
          />
          {vusError ? (
            <p id={vusErrorId} className="inline-note is-error">
              {vusError}
            </p>
          ) : null}
        </label>

        <label className="field">
          <span>Duration</span>
          <input
            type="text"
            value={runnerOptions.duration}
            onChange={(event) => onDurationChange(event.target.value)}
            placeholder="1m"
          />
        </label>

        <label className="field">
          <span>Ramp-up mode</span>
          <select
            value={runnerOptions.rampUp}
            onChange={(event) =>
              onRampUpChange(event.target.value as K6Options["rampUp"])
            }
          >
            <option value="instant">Instant</option>
            <option value="gradual">Gradual</option>
            <option value="staged">Staged</option>
          </select>
        </label>

        <label className="field">
          <span>Ramp-up time</span>
          <input
            type="text"
            value={runnerOptions.rampUpTime ?? ""}
            onChange={(event) => onRampUpTimeChange(event.target.value)}
            placeholder="30s"
            disabled={runnerOptions.rampUp === "instant"}
          />
        </label>

        <label className="field">
          <span>P95 threshold (ms)</span>
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={thresholdInputs.p95ResponseTime}
            aria-label="P95 threshold (ms)"
            onChange={(event) =>
              onThresholdChange("p95ResponseTime", event.target.value)
            }
            placeholder="2000"
            aria-invalid={thresholdErrors.p95ResponseTime ? "true" : undefined}
            aria-describedby={
              thresholdErrors.p95ResponseTime ? p95ThresholdErrorId : undefined
            }
          />
          {thresholdErrors.p95ResponseTime ? (
            <p id={p95ThresholdErrorId} className="inline-note is-error">
              {thresholdErrors.p95ResponseTime}
            </p>
          ) : null}
        </label>

        <label className="field">
          <span>Error-rate threshold (%)</span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            inputMode="numeric"
            value={thresholdInputs.errorRate}
            aria-label="Error-rate threshold (%)"
            onChange={(event) =>
              onThresholdChange("errorRate", event.target.value)
            }
            placeholder="5"
            aria-invalid={thresholdErrors.errorRate ? "true" : undefined}
            aria-describedby={
              thresholdErrors.errorRate ? errorRateThresholdErrorId : undefined
            }
          />
          {thresholdErrors.errorRate ? (
            <p id={errorRateThresholdErrorId} className="inline-note is-error">
              {thresholdErrors.errorRate}
            </p>
          ) : null}
        </label>

        <label className="field">
          <span>Traffic mode</span>
          <select
            value={runnerOptions.trafficMode}
            onChange={(event) =>
              onTrafficModeChange(
                event.target.value as K6Options["trafficMode"],
              )
            }
          >
            <option value="sequential">Sequential</option>
            <option value="weighted">Weighted mix</option>
          </select>
        </label>

        <div className="field field-note">
          <span>Traffic mode notes</span>
          <p className="inline-note">
            {runnerOptions.trafficMode === "weighted"
              ? "Edit request weights in Source."
              : "Runs selected requests in order."}
          </p>
        </div>

        <section
          className="auth-setup-panel field-wide"
          aria-labelledby="auth-setup-title"
        >
          <div className="auth-setup-heading">
            <div>
              <p className="eyebrow">Request target & auth</p>
              <h4 id="auth-setup-title">Fill from cURL or enter manually</h4>
            </div>
            <p className="field-hint">Paste cURL or type values manually.</p>
          </div>

          <label className="field field-wide">
            <span>Paste Postman cURL</span>
            <textarea
              value={curlInput}
              onChange={(event) => onCurlInputChange(event.target.value)}
              placeholder="curl --location 'https://api.example.com/users' --header 'Customerid: ...' --data '{...}'"
              rows={4}
              aria-describedby={curlImportStatusId}
            />
          </label>

          <div className="action-row curl-action-row">
            <button
              type="button"
              className="ghost"
              onClick={onApplyCurlCommand}
              disabled={!curlInput.trim()}
            >
              Apply Request Details
            </button>
            <p
              id={curlImportStatusId}
              className={`inline-note${
                curlImportState.status === "error"
                  ? " is-error"
                  : curlImportState.status === "ready"
                    ? " is-success"
                    : ""
              }`}
              aria-live="polite"
            >
              {curlImportState.message ??
                "Optional: apply Base URL, bearer token, headers, and a single-request body from Postman cURL."}
            </p>
          </div>

          <div className="manual-entry-block">
            <p className="manual-entry-label">Or enter manually</p>
            <div className="manual-entry-grid">
              <label className="field">
                <span>Base URL</span>
                <input
                  type="text"
                  inputMode="url"
                  value={runnerOptions.baseUrl ?? ""}
                  aria-label="Base URL"
                  onChange={(event) => onBaseUrlChange(event.target.value)}
                  placeholder="https://api.example.com"
                />
                <p className="inline-note">
                  Request host for relative or variable URLs.
                </p>
              </label>

              <label className="field">
                <span>Bearer token / JWT</span>
                <input
                  type="password"
                  value={runnerOptions.authToken ?? ""}
                  aria-label="Bearer token / JWT"
                  onChange={(event) => onAuthTokenChange(event.target.value)}
                  placeholder="Raw JWT or Authorization: Bearer ..."
                />
                <p className="inline-note">
                  Optional for unauthenticated requests.
                </p>
              </label>
            </div>
          </div>

          <div className="request-headers-block">
            <div className="request-headers-heading">
              <div>
                <p className="manual-entry-label">Request headers</p>
                <p className="inline-note">
                  Runtime headers override matching collection headers.
                </p>
              </div>
              <button
                type="button"
                className="ghost"
                onClick={handleAddRequestHeader}
              >
                Add Header
              </button>
            </div>

            {requestHeaderEntries.length > 0 ? (
              <div className="request-headers-table">
                {requestHeaderEntries.map(({ key, value, rowId }, index) => {
                  const nameError = requestHeaderNameErrors[rowId];
                  const nameErrorId = `${rowId}-name-error`;

                  return (
                    <div className="request-header-row" key={rowId}>
                      <label className="field">
                        <span>Header name</span>
                        <input
                          type="text"
                          value={key}
                          aria-label={`Request header ${index + 1} name`}
                          onChange={(event) =>
                            handleRequestHeaderKeyChange(
                              key,
                              event.target.value,
                            )
                          }
                          placeholder="Customerid"
                          aria-invalid={nameError ? "true" : undefined}
                          aria-describedby={nameError ? nameErrorId : undefined}
                        />
                        {nameError ? (
                          <p
                            id={nameErrorId}
                            className="inline-note is-error"
                            role="alert"
                          >
                            {nameError}
                          </p>
                        ) : null}
                      </label>

                      <label className="field">
                        <span>Header value</span>
                        <input
                          type="password"
                          value={value}
                          aria-label={`Request header ${index + 1} value`}
                          onChange={(event) =>
                            handleRequestHeaderValueChange(
                              key,
                              event.target.value,
                            )
                          }
                          placeholder="Header value"
                        />
                      </label>

                      <button
                        type="button"
                        className="ghost request-header-remove"
                        onClick={() => handleRemoveRequestHeader(key)}
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="inline-note">No runtime headers configured.</p>
            )}
          </div>

          {requestBodyOverride ? (
            <div className="request-body-override-block">
              <div className="request-headers-heading">
                <div>
                  <p className="manual-entry-label">Request body override</p>
                  <p className="inline-note">
                    Applies only to request {requestBodyOverride.requestId}.
                  </p>
                </div>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => onRequestBodyOverrideChange(undefined)}
                >
                  Clear Body
                </button>
              </div>
              <label className="field field-wide">
                <span>Body</span>
                <textarea
                  value={requestBodyOverride.body}
                  onChange={(event) =>
                    onRequestBodyOverrideChange({
                      ...requestBodyOverride,
                      body: event.target.value,
                    })
                  }
                  rows={5}
                />
              </label>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function nextHeaderKey(headers: Record<string, string>): string {
  const baseKey = "X-Header";
  const normalizedKeys = new Set(
    Object.keys(headers).map((key) => key.toLowerCase()),
  );
  if (!normalizedKeys.has(baseKey.toLowerCase())) {
    return baseKey;
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${baseKey}-${index}`;
    if (!normalizedKeys.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}
