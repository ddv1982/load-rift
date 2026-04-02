import { useEffect, useMemo, useState } from "react";
import { CollectionImportSection } from "./components/CollectionImportSection";
import { TestHarnessSection } from "./components/TestHarnessSection";
import { buildReportFileName, formatCount, truncateLog } from "./utils";
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

export function App() {
  const [lastSmokeInputKey, setLastSmokeInputKey] = useState<string | null>(null);
  const [collectionRevision, setCollectionRevision] = useState(0);
  const api = useLoadRiftApi();
  const {
    state: importState,
    importFromFile,
    reportError,
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
    updateRunnerOption,
    updateThreshold,
    updateRuntimeVariable,
    updateSelectedRequestIds,
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

  const { state: configValidation, validateNow } = useConfigValidation({
    collection,
    options: runnerOptions,
    isBusy: testState.isBusy,
    isRunning: testState.isRunning,
    isStarting: testState.isStarting,
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
      !isHarnessBusy,
    [configValidation.status, importState.collection, isHarnessBusy],
  );
  const canSmokeTest = useMemo(
    () => Boolean(importState.collection) && !isHarnessBusy,
    [importState.collection, isHarnessBusy],
  );
  const smokeInputKey = useMemo(
    () => buildSmokeInputKey(collection, runnerOptions, collectionRevision),
    [collection, collectionRevision, runnerOptions],
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

  const harnessStatus = {
    collection,
    testState: displayedTestState,
    smokeTestState: displayedSmokeTestState,
    configValidation,
    canStartTest,
    canSmokeTest,
    displayedTestStatus,
    displayedVerdict,
  };

  const harnessControls = {
    runnerOptions,
    emptyRuntimeVariables,
    curlInput,
    curlImportState,
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
    onVusChange: (value: number) => updateRunnerOption("vus", value),
    onDurationChange: (value: string) => updateRunnerOption("duration", value),
    onRampUpChange: (value: K6Options["rampUp"]) =>
      updateRunnerOption("rampUp", value),
    onRampUpTimeChange: (value: string) =>
      updateRunnerOption("rampUpTime", value),
    onThresholdChange: updateThreshold,
    onAuthTokenChange: (value: string) => updateRunnerOption("authToken", value),
    onCurlInputChange: handleCurlInputChange,
    onApplyCurlCommand: applyCurlCommand,
    onRuntimeVariableChange: updateRuntimeVariable,
    onAdvancedOptionsChange: (value: string) =>
      updateRunnerOption("advancedOptionsJson", value),
  };

  useEffect(() => {
    setCollectionRevision((previous) => previous + 1);
  }, [collection]);

  async function handleFileImport() {
    setIsPickingFile(true);

    try {
      const filePath = await selectCollectionFile();

      if (!filePath) {
        return;
      }

      await importFromFile(filePath);
    } catch (error) {
      reportError(
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
    await validateNow(runnerOptions);
  }

  async function handleStartTest() {
    setLastSmokeInputKey(null);
    clearSmokeTest();
    await startTest(runnerOptions);
  }

  async function handleSmokeTest() {
    setLastSmokeInputKey(smokeInputKey);
    await runSmokeTest(runnerOptions);
  }

  async function handleStopTest() {
    await stopTest();
  }

  async function handleExportLatestReport() {
    try {
      const savePath = await selectReportSavePath(
        buildReportFileName(runnerOptions.baseUrl),
      );
      if (!savePath) {
        return;
      }

      await api.exportReport({ savePath });
    } catch (error) {
      reportError(
        getTauriErrorMessage(error, "Failed to export the latest k6 report."),
      );
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
              ? `${collection.name} is loaded. Move from collection setup to run controls and live diagnostics without the old dashboard clutter.`
              : "Import a Postman collection, derive runtime inputs, and run local k6 checks from one tighter, more professional workspace."}
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
        <CollectionImportSection
          collection={collection}
          selectedRequestIds={runnerOptions.selectedRequestIds}
          error={importState.error}
          isLoading={importState.isLoading}
          isPickingFile={isPickingFile}
          onFileImport={() => void handleFileImport()}
          onReset={reset}
          onSelectionChange={updateSelectedRequestIds}
        />

        <TestHarnessSection
          status={harnessStatus}
          controls={harnessControls}
          actions={harnessActions}
        />
      </main>
    </div>
  );
}
