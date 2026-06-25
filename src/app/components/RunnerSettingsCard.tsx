import { useId } from "react";
import type { K6Options } from "../../lib/loadrift/types";
import type {
  ThresholdInputErrors,
  ThresholdInputValues,
} from "../hooks/useRunnerOptions";
import type { CurlImportState } from "../types";
import { SettingsCardHeader } from "./SettingsCardHeader";

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
  onCurlInputChange,
  onApplyCurlCommand,
}: RunnerSettingsCardProps) {
  const vusErrorId = useId();
  const p95ThresholdErrorId = useId();
  const errorRateThresholdErrorId = useId();
  const curlImportStatusId = useId();

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
              placeholder="curl --location 'https://api.example.com/users' --header 'Authorization: Bearer ...'"
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
              Extract URL & Token
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
                "Optional: extract Base URL and bearer token from Postman cURL."}
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
        </section>
      </div>
    </div>
  );
}
