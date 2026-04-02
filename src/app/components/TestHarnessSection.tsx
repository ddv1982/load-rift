import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type {
  CollectionInfo,
  K6Options,
  RuntimeVariable,
} from "../../lib/loadrift/types";
import type { TestHarnessState } from "../../features/test/useTestHarness";
import type {
  ConfigValidationState,
} from "../../features/test/useConfigValidation";
import type { CurlImportState } from "../types";
import { loadHarnessTab, saveHarnessTab, type HarnessTab } from "../persistence";
import { AdvancedOptionsCard } from "./AdvancedOptionsCard";
import { LatestResultCard } from "./LatestResultCard";
import { LiveRunMonitorCard } from "./LiveRunMonitorCard";
import { RunnerSettingsCard } from "./RunnerSettingsCard";
import { RuntimeVariablesCard } from "./RuntimeVariablesCard";
import { SmokeTestCard } from "./SmokeTestCard";
import type { SmokeTestState } from "../../features/test/useSmokeTest";

interface TestHarnessStatusProps {
  collection: CollectionInfo | null;
  testState: TestHarnessState;
  configValidation: ConfigValidationState;
  canStartTest: boolean;
  canSmokeTest: boolean;
  displayedTestStatus: string;
  displayedVerdict: string;
  smokeTestState: SmokeTestState;
}

interface TestHarnessControlsProps {
  runnerOptions: K6Options;
  emptyRuntimeVariables: RuntimeVariable[];
  curlInput: string;
  curlImportState: CurlImportState;
  eventLogRef: RefObject<HTMLPreElement | null>;
  resultSummaryRef: RefObject<HTMLDivElement | null>;
}

interface TestHarnessActionsProps {
  onStartTest: () => void;
  onSmokeTest: () => void;
  onStopTest: () => void;
  onValidateConfiguration: () => void;
  onRefreshStatus: () => void;
  onExportLatestReport: () => void;
  onVusChange: (value: number) => void;
  onDurationChange: (value: string) => void;
  onRampUpChange: (value: K6Options["rampUp"]) => void;
  onRampUpTimeChange: (value: string) => void;
  onThresholdChange: (key: keyof K6Options["thresholds"], value: string) => void;
  onAuthTokenChange: (value: string) => void;
  onCurlInputChange: (value: string) => void;
  onApplyCurlCommand: () => void;
  onRuntimeVariableChange: (key: string, value: string) => void;
  onAdvancedOptionsChange: (value: string) => void;
}

interface TestHarnessSectionProps {
  status: TestHarnessStatusProps;
  controls: TestHarnessControlsProps;
  actions: TestHarnessActionsProps;
}

export function TestHarnessSection({
  status,
  controls,
  actions,
}: TestHarnessSectionProps) {
  const {
    collection,
    testState,
    configValidation,
    canStartTest,
    canSmokeTest,
    displayedTestStatus,
    displayedVerdict,
    smokeTestState,
  } = status;
  const {
    runnerOptions,
    emptyRuntimeVariables,
    curlInput,
    curlImportState,
    eventLogRef,
    resultSummaryRef,
  } = controls;
  const {
    onStartTest,
    onSmokeTest,
    onStopTest,
    onValidateConfiguration,
    onRefreshStatus,
    onExportLatestReport,
    onVusChange,
    onDurationChange,
    onRampUpChange,
    onRampUpTimeChange,
    onThresholdChange,
    onAuthTokenChange,
    onCurlInputChange,
    onApplyCurlCommand,
    onRuntimeVariableChange,
    onAdvancedOptionsChange,
  } = actions;
  const tabListId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeTab, setActiveTab] = useState<HarnessTab>(() => loadHarnessTab("controls"));
  const tabs: HarnessTab[] = ["controls", "variables", "advanced"];

  useEffect(() => {
    saveHarnessTab(activeTab);
  }, [activeTab]);

  function focusTab(index: number) {
    tabRefs.current[index]?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;

    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % tabs.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (!nextTab) {
      return;
    }

    setActiveTab(nextTab);
    focusTab(nextIndex);
  }

  return (
    <section className="panel harness-panel workflow-panel">
      <div className="section-heading section-heading-wide">
        <div className="section-heading-copy">
          <p className="panel-kicker">Step 2 · Run</p>
          <h2>Configure and launch</h2>
          <p className="section-copy">
            Keep the primary controls front and center, then dip into variables,
            advanced settings, and diagnostics only when they matter.
          </p>
        </div>

        <div className="harness-heading-meta">
          <span className={`status-pill is-${displayedTestStatus}`}>
            {displayedVerdict}
          </span>
          <p className="panel-copy">
            {collection
              ? "Ready to validate configuration, run a smoke check, or launch the full load profile."
              : "Import a collection first to unlock the run workflow."}
          </p>
        </div>
      </div>

      <div className="action-row harness-action-row">
        <button
          type="button"
          className="primary"
          onClick={onStartTest}
          disabled={!canStartTest}
        >
          {testState.isStarting ? "Starting..." : "Start Test"}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={onSmokeTest}
          disabled={!canSmokeTest}
        >
          {smokeTestState.isRunning ? "Smoking..." : "Smoke Test"}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={onValidateConfiguration}
          disabled={!collection || configValidation.status === "checking"}
        >
          {configValidation.status === "checking" ? "Checking..." : "Check Config"}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={onStopTest}
          disabled={!testState.isRunning || testState.isStarting}
        >
          Stop
        </button>
        <button
          type="button"
          className="ghost"
          onClick={onRefreshStatus}
          disabled={testState.isBusy}
        >
          Refresh Status
        </button>
      </div>

      <div className="status-strip" aria-label="Run metrics overview">
        <article className="status-chip">
          <span>Run State</span>
          <strong>{displayedTestStatus.toUpperCase()}</strong>
        </article>
        <article className="status-chip">
          <span>Verdict</span>
          <strong>{displayedVerdict}</strong>
        </article>
        <article className="status-chip">
          <span>Active VUs</span>
          <strong>{testState.metrics.activeVus}</strong>
        </article>
        <article className="status-chip">
          <span>Total Requests</span>
          <strong>{testState.metrics.totalRequests}</strong>
        </article>
        <article className="status-chip">
          <span>P95</span>
          <strong>{testState.metrics.p95ResponseTime} ms</strong>
        </article>
        <article className="status-chip">
          <span>Error Rate</span>
          <strong>{(testState.metrics.errorRate * 100).toFixed(1)}%</strong>
        </article>
        <article className="status-chip">
          <span>Req/s</span>
          <strong>{testState.metrics.requestsPerSecond.toFixed(1)}</strong>
        </article>
      </div>

      <div className="harness-primary-grid">
        <div className="harness-main">
          {configValidation.status !== "idle" ? (
            <div
              className={`validation-banner${
                configValidation.status === "ready"
                  ? " is-ready"
                  : configValidation.status === "invalid"
                    ? " is-invalid"
                    : ""
              }`}
            >
              <strong>Configuration Check</strong>
              <p>{configValidation.message}</p>
            </div>
          ) : null}

          <div className="workflow-card workflow-card-primary">
            <div className="workflow-card-header">
              <div>
                <p className="eyebrow">Run profile</p>
                <h3>Primary controls</h3>
              </div>
              <p className="field-hint">
                Use the common settings first. Variables and advanced JSON stay
                one click away when the collection needs them.
              </p>
            </div>

            <div
              className="segmented-control segmented-control-compact"
              role="tablist"
              aria-label="Test harness controls"
            >
              {tabs.map((tab, index) => {
                const isActive = activeTab === tab;
                const tabId = `${tabListId}-${tab}-tab`;
                const panelId = `${tabListId}-${tab}-panel`;
                const label = tab === "controls"
                  ? "Controls"
                  : tab === "variables"
                    ? "Variables"
                    : "Advanced";

                return (
                  <button
                    key={tab}
                    ref={(element) => {
                      tabRefs.current[index] = element;
                    }}
                    type="button"
                    role="tab"
                    id={tabId}
                    aria-selected={isActive}
                    aria-controls={panelId}
                    tabIndex={isActive ? 0 : -1}
                    className={isActive ? "is-active" : ""}
                    onClick={() => setActiveTab(tab)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="control-deck">
              <div
                role="tabpanel"
                id={`${tabListId}-controls-panel`}
                aria-labelledby={`${tabListId}-controls-tab`}
                hidden={activeTab !== "controls"}
              >
                <RunnerSettingsCard
                  runnerOptions={runnerOptions}
                  curlInput={curlInput}
                  curlImportState={curlImportState}
                  onVusChange={onVusChange}
                  onDurationChange={onDurationChange}
                  onRampUpChange={onRampUpChange}
                  onRampUpTimeChange={onRampUpTimeChange}
                  onThresholdChange={onThresholdChange}
                  onAuthTokenChange={onAuthTokenChange}
                  onCurlInputChange={onCurlInputChange}
                  onApplyCurlCommand={onApplyCurlCommand}
                />
              </div>

              <div
                role="tabpanel"
                id={`${tabListId}-variables-panel`}
                aria-labelledby={`${tabListId}-variables-tab`}
                hidden={activeTab !== "variables"}
              >
                <RuntimeVariablesCard
                  collection={collection}
                  runnerOptions={runnerOptions}
                  emptyRuntimeVariables={emptyRuntimeVariables}
                  onRuntimeVariableChange={onRuntimeVariableChange}
                />
              </div>

              <div
                role="tabpanel"
                id={`${tabListId}-advanced-panel`}
                aria-labelledby={`${tabListId}-advanced-tab`}
                hidden={activeTab !== "advanced"}
              >
                <AdvancedOptionsCard
                  value={runnerOptions.advancedOptionsJson ?? ""}
                  onChange={onAdvancedOptionsChange}
                />
              </div>
            </div>
          </div>
        </div>

        <aside className="harness-monitor-column" aria-label="Live run monitor">
          <LiveRunMonitorCard
            output={testState.output}
            error={testState.error}
            eventLogRef={eventLogRef}
            onExportLatestReport={onExportLatestReport}
          />
        </aside>
      </div>

      <div className="harness-secondary-grid">
        <div className="harness-secondary-card">
          <SmokeTestCard
            result={smokeTestState.result}
            error={smokeTestState.error}
            isRunning={smokeTestState.isRunning}
          />
        </div>
        <div className="harness-secondary-card">
          <LatestResultCard
            result={testState.result}
            resultSummaryRef={resultSummaryRef}
          />
        </div>
      </div>
    </section>
  );
}
