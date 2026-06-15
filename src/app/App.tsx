import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CollectionImportSection } from "./components/CollectionImportSection";
import { TestHarnessSection } from "./components/TestHarnessSection";
import {
  buildReportFileName,
  formatCount,
  normalizeRunnerOptionsForExecution,
  truncateLog,
} from "./utils";
import appIconUrl from "../assets/app-icon.svg";
import { useCollectionImport } from "../features/import/useCollectionImport";
import { useSmokeTest } from "../features/test/useSmokeTest";
import { useTestHarness } from "../features/test/useTestHarness";
import { useConfigValidation } from "../features/test/useConfigValidation";
import { useLoadRiftApi } from "../lib/loadrift/context";
import type { CollectionInfo, K6Options } from "../lib/loadrift/types";
import {
  selectCollectionFile,
  selectReportSavePath,
} from "../lib/tauri/dialog";
import { getTauriErrorMessage } from "../lib/tauri/errors";
import { useCurlImport } from "./hooks/useCurlImport";
import { useRunnerOptions } from "./hooks/useRunnerOptions";
import { useWorkspaceLayout } from "./hooks/useWorkspaceLayout";

function buildSmokeInputKey(
  collection: CollectionInfo | null,
  runnerOptions: K6Options,
  collectionRevision: number,
) {
  return JSON.stringify({
    collectionRevision,
    collection: collection
      ? {
          name: collection.name,
          requestCount: collection.requestCount,
          requests: collection.requests.map((request) => ({
            id: request.id,
            name: request.name,
            method: request.method,
            url: request.url,
            folderPath: request.folderPath,
          })),
          runtimeVariables: collection.runtimeVariables.map((variable) => ({
            key: variable.key,
            defaultValue: variable.defaultValue ?? "",
          })),
        }
      : null,
    baseUrl: runnerOptions.baseUrl?.trim() ?? "",
    authToken: runnerOptions.authToken?.trim() ?? "",
    variableOverrides: Object.entries(runnerOptions.variableOverrides).sort(
      ([leftKey], [rightKey]) => leftKey.localeCompare(rightKey),
    ),
    selectedRequestIds: [...runnerOptions.selectedRequestIds].sort(),
  });
}

function AppIcon() {
  return <img className="app-icon" src={appIconUrl} alt="" aria-hidden="true" />;
}

type WorkflowStep = "source" | "configure" | "run";

const workflowSteps: WorkflowStep[] = ["source", "configure", "run"];

function getWorkflowStepLabel(step: WorkflowStep) {
  if (step === "source") {
    return "Source";
  }

  if (step === "configure") {
    return "Configure";
  }

  return "Run";
}

export function App() {
  const workflowTabsId = useId();
  const sourcePanelRef = useRef<HTMLDivElement | null>(null);
  const workflowTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeWorkflowStep, setActiveWorkflowStep] = useState<WorkflowStep>("source");
  const [lastSmokeInputKey, setLastSmokeInputKey] = useState<string | null>(null);
  const [collectionRevision, setCollectionRevision] = useState(0);
  const [exportNotice, setExportNotice] = useState<{
    tone: "error" | "success";
    message: string;
  } | null>(null);
  const api = useLoadRiftApi();
  const {
    state: importState,
    importFromFile,
    reportError: reportImportError,
    reset,
  } = useCollectionImport();
  const {
    state: testState,
    refreshStatus,
    startTest,
    stopTest,
  } = useTestHarness();
  const {
    state: smokeTestState,
    runSmokeTest,
    clearSmokeTest,
  } = useSmokeTest();
  const [isPickingFile, setIsPickingFile] = useState(false);
  const collection = importState.collection;
  const {
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
  } = useRunnerOptions(collection);
  const {
    curlInput,
    curlImportState,
    applyCurlCommand,
    handleCurlInputChange,
  } = useCurlImport(setRunnerOptions);
  const {
    workspaceShellRef,
    eventLogRef,
    resultSummaryRef,
  } = useWorkspaceLayout({
    output: testState.output,
    result: testState.result,
  });

  const effectiveRunnerOptions = useMemo(
    () => normalizeRunnerOptionsForExecution(runnerOptions),
    [runnerOptions],
  );

  const { state: configValidation, validateNow } = useConfigValidation({
    collection,
    options: effectiveRunnerOptions,
    isBusy: testState.isBusy,
    isRunning: testState.isRunning,
    isStarting: testState.isStarting,
    isEnabled: runnerOptionsAreValid,
  });

  const isHarnessBusy =
    testState.isBusy ||
    testState.isRunning ||
    testState.isStarting ||
    smokeTestState.isRunning;

  const canStartTest = useMemo(
    () =>
      Boolean(importState.collection) &&
      configValidation.status === "ready" &&
      runnerOptionsAreValid &&
      !isHarnessBusy,
    [configValidation.status, importState.collection, isHarnessBusy, runnerOptionsAreValid],
  );
  const canSmokeTest = useMemo(
    () => Boolean(importState.collection) && runnerOptionsAreValid && !isHarnessBusy,
    [importState.collection, isHarnessBusy, runnerOptionsAreValid],
  );
  const smokeInputKey = useMemo(
    () => buildSmokeInputKey(collection, effectiveRunnerOptions, collectionRevision),
    [collection, collectionRevision, effectiveRunnerOptions],
  );
  const displayedSmokeTestState = useMemo(() => {
    if (
      lastSmokeInputKey &&
      !smokeTestState.isRunning &&
      lastSmokeInputKey !== smokeInputKey
    ) {
      return {
        ...smokeTestState,
        result: null,
        error: null,
      };
    }

    return smokeTestState;
  }, [lastSmokeInputKey, smokeInputKey, smokeTestState]);

  const displayedTestStatus = testState.isStarting ? "starting" : testState.status;
  const displayedVerdict = testState.result
    ? testState.result.status.toUpperCase()
    : displayedTestStatus.toUpperCase();
  const displayedTestState = {
    ...testState,
    output: truncateLog(testState.output),
  };
  const activeWorkflowIndex = workflowSteps.indexOf(activeWorkflowStep);

  const harnessStatus = {
    collection,
    testState: displayedTestState,
    exportNotice,
    smokeTestState: displayedSmokeTestState,
    configValidation,
    canStartTest,
    canSmokeTest,
    runnerOptionsAreValid,
    displayedTestStatus,
    displayedVerdict,
  };

  const harnessControls = {
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
  };

  const harnessActions = {
    onStartTest: () => void handleStartTest(),
    onSmokeTest: () => void handleSmokeTest(),
    onStopTest: () => void handleStopTest(),
    onValidateConfiguration: () => void handleValidateConfiguration(),
    onRefreshStatus: () => void handleRefreshStatus(),
    onExportLatestReport: () => void handleExportLatestReport(),
    onVusChange: updateVusInput,
    onDurationChange: (value: string) => updateRunnerOption("duration", value),
    onRampUpChange: (value: K6Options["rampUp"]) =>
      updateRunnerOption("rampUp", value),
    onRampUpTimeChange: (value: string) =>
      updateRunnerOption("rampUpTime", value),
    onThresholdChange: updateThreshold,
    onTrafficModeChange: (value: K6Options["trafficMode"]) =>
      updateRunnerOption("trafficMode", value),
    onAuthTokenChange: (value: string) => updateRunnerOption("authToken", value),
    onBaseUrlChange: (value: string) => {
      updateRunnerOption("baseUrl", value);
    },
    onCurlInputChange: handleCurlInputChange,
    onApplyCurlCommand: applyCurlCommand,
    onRuntimeVariableChange: updateRuntimeVariable,
    onAdvancedOptionsChange: (value: string) =>
      updateRunnerOption("advancedOptionsJson", value),
  };

  useEffect(() => {
    setCollectionRevision((previous) => previous + 1);
  }, [collection]);

  useEffect(() => {
    if (!collection) {
      setActiveWorkflowStep("source");
      return;
    }

    setActiveWorkflowStep((currentStep) => {
      if (currentStep !== "source") {
        return currentStep;
      }

      if (sourcePanelRef.current?.contains(document.activeElement)) {
        workflowTabRefs.current[1]?.focus();
      }

      return "configure";
    });
  }, [collection]);

  function focusWorkflowTab(index: number) {
    workflowTabRefs.current[index]?.focus();
  }

  function handleWorkflowTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;

    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % workflowSteps.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + workflowSteps.length) % workflowSteps.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = workflowSteps.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextStep = workflowSteps[nextIndex];
    if (!nextStep) {
      return;
    }

    setActiveWorkflowStep(nextStep);
    focusWorkflowTab(nextIndex);
  }

  async function handleFileImport() {
    setIsPickingFile(true);

    try {
      const filePath = await selectCollectionFile();

      if (!filePath) {
        return;
      }

      await importFromFile(filePath);
    } catch (error) {
      reportImportError(
        getTauriErrorMessage(error, "Failed to open the collection file picker."),
      );
    } finally {
      setIsPickingFile(false);
    }
  }

  async function handleRefreshStatus() {
    await refreshStatus();
  }

  async function handleValidateConfiguration() {
    if (!runnerOptionsAreValid) {
      return;
    }

    await validateNow(effectiveRunnerOptions);
  }

  async function handleStartTest() {
    if (!runnerOptionsAreValid) {
      return;
    }

    setLastSmokeInputKey(null);
    setExportNotice(null);
    clearSmokeTest();
    await startTest(effectiveRunnerOptions);
  }

  async function handleSmokeTest() {
    if (!runnerOptionsAreValid) {
      return;
    }

    setLastSmokeInputKey(smokeInputKey);
    setExportNotice(null);
    await runSmokeTest(effectiveRunnerOptions);
  }

  async function handleStopTest() {
    setExportNotice(null);
    await stopTest();
  }

  async function handleExportLatestReport() {
    try {
      setExportNotice(null);
      const savePath = await selectReportSavePath(
        buildReportFileName(effectiveRunnerOptions.baseUrl),
      );
      if (!savePath) {
        return;
      }

      await api.exportReport({ savePath });
      setExportNotice({
        tone: "success",
        message: `Report saved to ${savePath}.`,
      });
    } catch (error) {
      setExportNotice({
        tone: "error",
        message: getTauriErrorMessage(error, "Failed to export the latest k6 report."),
      });
    }
  }

  return (
    <div className="app-shell">
      <header className="app-hero">
        <div className="app-hero-copy">
          <p className="eyebrow">Load Testing Workspace</p>
          <div className="app-title-row">
            <span className={`status-pill is-${displayedTestStatus}`}>
              {displayedTestStatus.replace("_", " ")}
            </span>
          </div>
          <div className="app-brand-row">
            <AppIcon />
            <h1>Load Rift</h1>
          </div>
          <p className="app-subtitle">
            {collection
              ? `${collection.name} is ready. Configure, run, and review without dashboard clutter.`
              : "Import a Postman collection, set runtime inputs, and run local k6 checks."}
          </p>
        </div>

        <dl className="overview-grid">
          <div className="overview-card">
            <dt>Collection</dt>
            <dd>{collection?.name ?? "No collection loaded"}</dd>
          </div>
          <div className="overview-card">
            <dt>Requests</dt>
            <dd>{collection ? formatCount("request", collection.requestCount) : "0 requests"}</dd>
          </div>
          <div className="overview-card">
            <dt>Variables</dt>
            <dd>
              {collection
                ? formatCount("variable", collection.runtimeVariables.length)
                : "0 variables"}
            </dd>
          </div>
          <div className="overview-card">
            <dt>Runner</dt>
            <dd>{displayedVerdict}</dd>
          </div>
        </dl>
      </header>

      <main ref={workspaceShellRef} className="workspace-shell">
        <nav className="workflow-stepper" aria-label="Load test workflow">
          <div className="workflow-step-tabs" role="tablist" aria-label="Workflow steps">
            {workflowSteps.map((step, index) => {
              const isActive = activeWorkflowStep === step;
              const tabId = `${workflowTabsId}-${step}-tab`;
              const panelId = `${workflowTabsId}-${step}-panel`;

              return (
                <button
                  key={step}
                  ref={(element) => {
                    workflowTabRefs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  id={tabId}
                  aria-selected={isActive}
                  aria-controls={panelId}
                  tabIndex={isActive ? 0 : -1}
                  className={isActive ? "is-active" : ""}
                  onClick={() => setActiveWorkflowStep(step)}
                  onKeyDown={(event) => handleWorkflowTabKeyDown(event, index)}
                >
                  <span className="workflow-step-index">{index + 1}</span>
                  <span>{getWorkflowStepLabel(step)}</span>
                </button>
              );
            })}
          </div>
          <p className="workflow-step-status">
            Step {activeWorkflowIndex + 1} of {workflowSteps.length}
          </p>
        </nav>

        <div
          ref={sourcePanelRef}
          role="tabpanel"
          id={`${workflowTabsId}-source-panel`}
          aria-labelledby={`${workflowTabsId}-source-tab`}
          hidden={activeWorkflowStep !== "source"}
        >
          <CollectionImportSection
            collection={collection}
            selectedRequestIds={runnerOptions.selectedRequestIds}
            requestWeights={runnerOptions.requestWeights}
            trafficMode={runnerOptions.trafficMode}
            error={importState.error}
            isLoading={importState.isLoading}
            isPickingFile={isPickingFile}
            onFileImport={() => void handleFileImport()}
            onReset={reset}
            onSelectionChange={updateSelectedRequestIds}
            onRequestWeightChange={updateRequestWeight}
          />
        </div>

        <div
          role="tabpanel"
          id={`${workflowTabsId}-configure-panel`}
          aria-labelledby={`${workflowTabsId}-configure-tab`}
          hidden={activeWorkflowStep !== "configure"}
        >
          {activeWorkflowStep === "configure" ? (
            <TestHarnessSection
              status={harnessStatus}
              controls={harnessControls}
              actions={harnessActions}
              activeStep="configure"
            />
          ) : null}
        </div>

        <div
          role="tabpanel"
          id={`${workflowTabsId}-run-panel`}
          aria-labelledby={`${workflowTabsId}-run-tab`}
          hidden={activeWorkflowStep !== "run"}
        >
          {activeWorkflowStep === "run" ? (
            <TestHarnessSection
              status={harnessStatus}
              controls={harnessControls}
              actions={harnessActions}
              activeStep="run"
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}
