import { LatestResultCard } from "./LatestResultCard";
import { LiveRunMonitorCard } from "./LiveRunMonitorCard";
import { SmokeTestCard } from "./SmokeTestCard";
import type {
  TestHarnessActionsProps,
  TestHarnessControlsProps,
  TestHarnessStatusProps,
} from "./TestHarnessSection.types";

interface TestHarnessRunPanelProps {
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

export function TestHarnessRunPanel({
  status,
  controls,
  actions,
}: TestHarnessRunPanelProps) {
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
  const { eventLogRef, resultSummaryRef } = controls;
  const {
    onStartTest,
    onSmokeTest,
    onStopTest,
    onValidateConfiguration,
    onRefreshStatus,
    onExportLatestReport,
  } = actions;
  const readiness = getRunReadinessMessage({
    collection,
    testState,
    smokeTestState,
    configValidation,
    canStartTest,
    runnerOptionsAreValid,
  });

  return (
    <section
      className={`panel harness-panel workflow-panel run-review-panel${
        canStartTest || testState.isRunning || testState.result || smokeTestState.result
          ? " is-current"
          : " is-locked"
      }`}
    >
      <div className="section-heading section-heading-wide">
        <div className="section-heading-copy">
          <p className="panel-kicker">Step 3 · Run &amp; Review</p>
          <h2>Validate, launch, and review</h2>
          <p className="section-copy">
            Check readiness, run smoke or load, then review the latest result.
          </p>
        </div>

        <div className="harness-heading-meta">
          <span className={`status-pill is-${displayedTestStatus}`}>
            {displayedVerdict}
          </span>
          <p className="panel-copy">
            {collection
              ? "Validate, smoke, or start the load profile."
              : "Import and configure to unlock runs."}
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
          {smokeTestState.isRunning ? "Smoke testing..." : "Smoke Test"}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={onValidateConfiguration}
          disabled={
            !collection ||
            !runnerOptionsAreValid ||
            configValidation.status === "checking"
          }
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
        <small>Completed-run stats stay in Latest result.</small>
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
        <aside className="harness-monitor-column" aria-label="Live run monitor">
          <LiveRunMonitorCard
            output={testState.output}
            error={testState.error}
            finishReason={testState.finishReason}
            resultSource={testState.resultSource}
            summaryIssue={testState.summaryIssue}
            eventLogRef={eventLogRef}
          />
        </aside>

        <div className="harness-secondary-stack">
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
              notice={exportNotice}
              resultSummaryRef={resultSummaryRef}
              onExportLatestReport={onExportLatestReport}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
