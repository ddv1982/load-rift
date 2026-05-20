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
import type { AdvancedOptionsFeedback } from "../advancedOptions";
import type { CurlImportState } from "../types";
import { loadHarnessTab, saveHarnessTab, type HarnessTab } from "../persistence";
import { AdvancedOptionsCard } from "./AdvancedOptionsCard";
import { LatestResultCard } from "./LatestResultCard";
import { LiveRunMonitorCard } from "./LiveRunMonitorCard";
import { RunnerSettingsCard } from "./RunnerSettingsCard";
import { RuntimeVariablesCard } from "./RuntimeVariablesCard";
import { SmokeTestCard } from "./SmokeTestCard";
import type { SmokeTestState } from "../../features/test/useSmokeTest";
import type { ThresholdInputErrors, ThresholdInputValues } from "../hooks/useRunnerOptions";

interface TestHarnessStatusProps {
  collection: CollectionInfo | null;
  testState: TestHarnessState;
  exportNotice: {
    tone: "error" | "success";
    message: string;
  } | null;
  configValidation: ConfigValidationState;
  canStartTest: boolean;
  canSmokeTest: boolean;
  runnerOptionsAreValid: boolean;
  displayedTestStatus: string;
  displayedVerdict: string;
  smokeTestState: SmokeTestState;
}

interface TestHarnessControlsProps {
  runnerOptions: K6Options;
  thresholdInputs: ThresholdInputValues;
  thresholdErrors: ThresholdInputErrors;
  vusInput: string;
  vusError: string | null;
  emptyRuntimeVariables: RuntimeVariable[];
  curlInput: string;
  curlImportState: CurlImportState;
  advancedOptionsFeedback: AdvancedOptionsFeedback | null;
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
  onVusChange: (value: string) => void;
  onDurationChange: (value: string) => void;
  onRampUpChange: (value: K6Options["rampUp"]) => void;
  onRampUpTimeChange: (value: string) => void;
  onThresholdChange: (key: keyof K6Options["thresholds"], value: string) => void;
  onTrafficModeChange: (value: K6Options["trafficMode"]) => void;
  onAuthTokenChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
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

type ReadinessTone = "ready" | "blocked" | "busy" | "checking";

function getRunReadinessMessage({
  collection,
  testState,
  smokeTestState,
  configValidation,
  canStartTest,
  runnerOptionsAreValid,
}: Pick<
  TestHarnessStatusProps,
  | "collection"
  | "testState"
  | "smokeTestState"
  | "configValidation"
  | "canStartTest"
  | "runnerOptionsAreValid"
>): { tone: ReadinessTone; message: string } {
  if (!collection) {
    return { tone: "blocked", message: "Import a collection to unlock run actions." };
  }

  if (testState.isStarting) {
    return {
      tone: "busy",
      message: "Starting the load test; actions pause until the runner responds.",
    };
  }

  if (testState.isRunning) {
    return {
      tone: "busy",
      message: "A load test is running. Stop it before starting another run.",
    };
  }

  if (smokeTestState.isRunning) {
    return {
      tone: "busy",
      message: "Smoke test is running; load actions pause until it finishes.",
    };
  }

  if (!runnerOptionsAreValid) {
    return {
      tone: "blocked",
      message: "Fix the highlighted runner inputs before starting.",
    };
  }

  if (configValidation.status === "checking") {
    return {
      tone: "checking",
      message: "Checking the current configuration before Start Test is enabled.",
    };
  }

  if (configValidation.status === "invalid") {
    return {
      tone: "blocked",
      message: configValidation.message ?? "Configuration is not ready yet.",
    };
  }

  if (canStartTest) {
    return {
      tone: "ready",
      message: "Ready to start a load test or run another smoke check.",
    };
  }

  return { tone: "checking", message: "Check configuration to enable Start Test." };
}

export function TestHarnessSection({
  status,
  controls,
  actions,
}: TestHarnessSectionProps) {
  const {
    collection,
    testState,
    exportNotice,
    configValidation,
    canStartTest,
    canSmokeTest,
    runnerOptionsAreValid,
    displayedTestStatus,
    displayedVerdict,
    smokeTestState,
  } = status;
  const {
    runnerOptions,
    thresholdInputs,
    thresholdErrors,
    vusInput,
    vusError,
    emptyRuntimeVariables,
    curlInput,
    curlImportState,
    advancedOptionsFeedback,
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
    onTrafficModeChange,
    onAuthTokenChange,
    onBaseUrlChange,
    onCurlInputChange,
    onApplyCurlCommand,
    onRuntimeVariableChange,
    onAdvancedOptionsChange,
  } = actions;
  const tabListId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeTab, setActiveTab] = useState<HarnessTab>(() => loadHarnessTab("controls"));
  const tabs: HarnessTab[] = ["controls", "variables", "advanced"];
  const readiness = getRunReadinessMessage({
    collection,
    testState,
    smokeTestState,
    configValidation,
    canStartTest,
    runnerOptionsAreValid,
  });
  const validationBanner = !runnerOptionsAreValid
    ? {
        status: "invalid" as const,
        message: "Fix the highlighted runner inputs before checking configuration or starting.",
      }
    : configValidation.status === "idle"
      ? null
      : configValidation;

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
          disabled={!collection || !runnerOptionsAreValid || configValidation.status === "checking"}
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
      <p className={`action-guidance is-${readiness.tone}`} aria-live="polite">
        {readiness.message}
      </p>

      <div className="live-metrics-heading">
        <span>Live metrics</span>
        <small>Final verdict and completed-run stats stay in Latest result.</small>
      </div>
      <div className="status-strip" aria-label="Live run metrics overview">
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
          {validationBanner ? (
            <div
              className={`validation-banner${
                validationBanner.status === "ready"
                  ? " is-ready"
                  : validationBanner.status === "invalid"
                    ? " is-invalid"
                    : ""
              }`}
            >
              <strong>Configuration Check</strong>
              <p>{validationBanner.message}</p>
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
                  thresholdInputs={thresholdInputs}
                  thresholdErrors={thresholdErrors}
                  vusInput={vusInput}
                  vusError={vusError}
                  curlInput={curlInput}
                  curlImportState={curlImportState}
                  onVusChange={onVusChange}
                  onDurationChange={onDurationChange}
                  onRampUpChange={onRampUpChange}
                  onRampUpTimeChange={onRampUpTimeChange}
                  onThresholdChange={onThresholdChange}
                  onTrafficModeChange={onTrafficModeChange}
                  onAuthTokenChange={onAuthTokenChange}
                  onBaseUrlChange={onBaseUrlChange}
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
                  feedback={advancedOptionsFeedback}
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
            finishReason={testState.finishReason}
            resultSource={testState.resultSource}
            summaryIssue={testState.summaryIssue}
            notice={exportNotice}
            hasLatestResult={Boolean(testState.result)}
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
            finishReason={testState.finishReason}
            resultSource={testState.resultSource}
            summaryIssue={testState.summaryIssue}
            error={testState.error}
            resultSummaryRef={resultSummaryRef}
          />
        </div>
      </div>
    </section>
  );
}
