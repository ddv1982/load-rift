import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AppHero } from "./components/AppHero";
import { ConfigurePanel } from "./components/ConfigurePanel";
import { RunPanel } from "./components/RunPanel";
import { SourcePanel } from "./components/SourcePanel";
import { WorkflowStepper } from "./components/WorkflowStepper";
import {
  buildReportFileName,
  normalizeRunnerOptionsForExecution,
  truncateLog,
} from "./utils";
import { useCollectionImport } from "../features/import/useCollectionImport";
import { useSmokeTest } from "../features/test/useSmokeTest";
import { useTestHarness } from "../features/test/useTestHarness";
import { useConfigValidation } from "../features/test/useConfigValidation";
import { useLoadRiftApi } from "../lib/loadrift/context";
import type { CollectionInfo, K6Options } from "../lib/loadrift/types";
import { getTauriErrorMessage } from "../lib/tauri/errors";
import { useCurlImport } from "./hooks/useCurlImport";
import { useRunnerOptions } from "./hooks/useRunnerOptions";
import { useWorkspaceLayout } from "./hooks/useWorkspaceLayout";
import type { WorkflowStep } from "./workflow";

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

export function App() {
  const workflowTabsId = useId();
  const sourcePanelRef = useRef<HTMLDivElement | null>(null);
  const workflowTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeWorkflowStep, setActiveWorkflowStep] =
    useState<WorkflowStep>("source");
  const [lastSmokeInputKey, setLastSmokeInputKey] = useState<string | null>(
    null,
  );
  const [collectionRevision, setCollectionRevision] = useState(0);
  const [exportNotice, setExportNotice] = useState<{
    tone: "error" | "success";
    message: string;
  } | null>(null);
  const api = useLoadRiftApi();
  const { state: importState, selectAndImport, reset } = useCollectionImport();
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
  const { workspaceShellRef, eventLogRef, resultSummaryRef } =
    useWorkspaceLayout({
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
    [
      configValidation.status,
      importState.collection,
      isHarnessBusy,
      runnerOptionsAreValid,
    ],
  );
  const canSmokeTest = useMemo(
    () =>
      Boolean(importState.collection) &&
      runnerOptionsAreValid &&
      !isHarnessBusy,
    [importState.collection, isHarnessBusy, runnerOptionsAreValid],
  );
  const smokeInputKey = useMemo(
    () =>
      buildSmokeInputKey(
        collection,
        effectiveRunnerOptions,
        collectionRevision,
      ),
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

  const displayedTestStatus = testState.isStarting
    ? "starting"
    : testState.status;
  const displayedVerdict = testState.result
    ? testState.result.status.toUpperCase()
    : displayedTestStatus.toUpperCase();
  const displayedTestState = {
    ...testState,
    output: truncateLog(testState.output),
  };
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
    onAuthTokenChange: (value: string) =>
      updateRunnerOption("authToken", value),
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

  async function handleFileImport() {
    setIsPickingFile(true);

    try {
      await selectAndImport();
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
      const result = await api.selectAndExportReport({
        defaultPath: buildReportFileName(effectiveRunnerOptions.baseUrl),
      });
      if (!result) {
        return;
      }

      setExportNotice({
        tone: "success",
        message: `Report saved to ${result.savePath}.`,
      });
    } catch (error) {
      setExportNotice({
        tone: "error",
        message: getTauriErrorMessage(
          error,
          "Failed to export the latest k6 report.",
        ),
      });
    }
  }

  return (
    <div className="app-shell">
      <AppHero
        collection={collection}
        displayedTestStatus={displayedTestStatus}
        displayedVerdict={displayedVerdict}
      />

      <main ref={workspaceShellRef} className="workspace-shell">
        <WorkflowStepper
          activeWorkflowStep={activeWorkflowStep}
          workflowTabsId={workflowTabsId}
          tabRefs={workflowTabRefs}
          onStepChange={setActiveWorkflowStep}
        />

        <SourcePanel
          panelRef={sourcePanelRef}
          workflowTabsId={workflowTabsId}
          isActive={activeWorkflowStep === "source"}
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

        <ConfigurePanel
          workflowTabsId={workflowTabsId}
          isActive={activeWorkflowStep === "configure"}
          status={harnessStatus}
          controls={harnessControls}
          actions={harnessActions}
        />

        <RunPanel
          workflowTabsId={workflowTabsId}
          isActive={activeWorkflowStep === "run"}
          status={harnessStatus}
          controls={harnessControls}
          actions={harnessActions}
        />
      </main>
    </div>
  );
}
