import type { K6Options } from "../../lib/loadrift/types";
import type { CurlImportState } from "../types";
import { SettingsCardHeader } from "./SettingsCardHeader";

interface RunnerSettingsCardProps {
  runnerOptions: K6Options;
  curlInput: string;
  curlImportState: CurlImportState;
  onVusChange: (value: number) => void;
  onDurationChange: (value: string) => void;
  onRampUpChange: (value: K6Options["rampUp"]) => void;
  onRampUpTimeChange: (value: string) => void;
  onThresholdChange: (key: keyof K6Options["thresholds"], value: string) => void;
  onTrafficModeChange: (value: K6Options["trafficMode"]) => void;
  onAuthTokenChange: (value: string) => void;
  onCurlInputChange: (value: string) => void;
  onApplyCurlCommand: () => void;
}

export function RunnerSettingsCard({
  runnerOptions,
  curlInput,
  curlImportState,
  onVusChange,
  onDurationChange,
  onRampUpChange,
  onRampUpTimeChange,
  onThresholdChange,
  onTrafficModeChange,
  onAuthTokenChange,
  onCurlInputChange,
  onApplyCurlCommand,
}: RunnerSettingsCardProps) {
  return (
    <div className="settings-card">
      <SettingsCardHeader
        eyebrow="Runner Settings"
        title="Basic k6 Controls"
        hint="Configure the common load profile here. Use advanced JSON below for the full k6 options surface. Weighted mix follows a deterministic weighted request schedule across started iterations, while advanced k6 scenarios remain the path for stricter fixed traffic splits."
      />

      <div className="settings-grid">
        <label className="field">
          <span>Virtual users</span>
          <input
            type="number"
            min={1}
            value={runnerOptions.vus}
            onChange={(event) => onVusChange(Number(event.target.value) || 1)}
          />
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
            value={runnerOptions.thresholds.p95ResponseTime ?? ""}
            onChange={(event) =>
              onThresholdChange("p95ResponseTime", event.target.value)
            }
            placeholder="2000"
          />
        </label>

        <label className="field">
          <span>Error-rate threshold (%)</span>
          <input
            type="number"
            min={0}
            max={100}
            value={runnerOptions.thresholds.errorRate ?? ""}
            onChange={(event) => onThresholdChange("errorRate", event.target.value)}
            placeholder="5"
          />
        </label>

        <label className="field">
          <span>Traffic mode</span>
          <select
            value={runnerOptions.trafficMode}
            onChange={(event) =>
              onTrafficModeChange(event.target.value as K6Options["trafficMode"])
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
              ? "Weighted mix follows a deterministic weighted schedule across started iterations. Use advanced k6 scenarios for stricter fixed ratios."
              : "Sequential mode runs every selected request in order during each iteration."}
          </p>
        </div>

        <label className="field field-wide">
          <span>Bearer token</span>
          <input
            type="password"
            value={runnerOptions.authToken ?? ""}
            onChange={(event) => onAuthTokenChange(event.target.value)}
            placeholder="Raw JWT or full Authorization: Bearer ... value"
          />
        </label>

        <label className="field field-wide">
          <span>Postman cURL snippet</span>
          <textarea
            value={curlInput}
            onChange={(event) => onCurlInputChange(event.target.value)}
            placeholder="Paste a working Postman cURL snippet here to extract the base URL and Authorization bearer/JWT token."
            rows={4}
          />
        </label>

        <div className="action-row">
          <button
            type="button"
            className="ghost"
            onClick={onApplyCurlCommand}
            disabled={!curlInput.trim()}
          >
            Apply Curl
          </button>
          <p
            className={`inline-note${
              curlImportState.status === "error"
                ? " is-error"
                : curlImportState.status === "ready"
                  ? " is-success"
                  : ""
            }`}
          >
            {curlImportState.message ??
              "Paste one working Postman cURL snippet here. Load Rift will extract the request origin and bearer/JWT token for the collection run."}
          </p>
        </div>

        <label className="field field-wide">
          <span>Derived base URL</span>
          <input
            type="url"
            value={runnerOptions.baseUrl ?? ""}
            readOnly
            placeholder="Apply a Postman cURL snippet to derive the base URL."
          />
        </label>
      </div>
    </div>
  );
}
