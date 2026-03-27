import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CollectionImportSection } from "./components/CollectionImportSection";
import { TestHarnessSection } from "./components/TestHarnessSection";
import { buildReportFileName, formatCount, truncateLog } from "./utils";
import { useCollectionImport } from "../features/import/useCollectionImport";
import { useSmokeTest } from "../features/test/useSmokeTest";
import { useTestHarness } from "../features/test/useTestHarness";
import { useConfigValidation } from "../features/test/useConfigValidation";
import { useLoadRiftApi } from "../lib/loadrift/context";
import {
  selectCollectionFile,
  selectReportSavePath,
} from "../lib/tauri/dialog";
import { getTauriErrorMessage } from "../lib/tauri/errors";
import { useCurlImport } from "./hooks/useCurlImport";
import { useRunnerOptions } from "./hooks/useRunnerOptions";
import { useWorkspaceLayout } from "./hooks/useWorkspaceLayout";
import type { CollectionInfo } from "../lib/loadrift/types";

export function App() {
  const previousSmokeCollectionRef = useRef<CollectionInfo | null>(null);
  const previousSmokeInputSignatureRef = useRef<string | null>(null);
  const pendingSmokeInvalidationRef = useRef(false);
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
    sidebarWidth,
    isResizingPanes,
    workspaceShellRef,
    eventLogRef,
    resultSummaryRef,
    startPaneResize,
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
  const smokeInputSignature = useMemo(
    () =>
      JSON.stringify({
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
      }),
    [
      collection,
      runnerOptions.authToken,
      runnerOptions.baseUrl,
      runnerOptions.selectedRequestIds,
      runnerOptions.variableOverrides,
    ],
  );

  const displayedTestStatus = testState.isStarting ? "starting" : testState.status;
  const displayedVerdict = testState.result
    ? testState.result.status.toUpperCase()
    : displayedTestStatus.toUpperCase();

  useEffect(() => {
    const previousCollection = previousSmokeCollectionRef.current;
    const previousSignature = previousSmokeInputSignatureRef.current;
    previousSmokeCollectionRef.current = collection;
    previousSmokeInputSignatureRef.current = smokeInputSignature;

    if (previousSignature === null && previousCollection === null) {
      return;
    }

    if (previousCollection !== collection || previousSignature !== smokeInputSignature) {
      if (smokeTestState.isRunning) {
        pendingSmokeInvalidationRef.current = true;
        return;
      }

      pendingSmokeInvalidationRef.current = false;
      clearSmokeTest();
      return;
    }

    if (!smokeTestState.isRunning && pendingSmokeInvalidationRef.current) {
      pendingSmokeInvalidationRef.current = false;
      clearSmokeTest();
    }
  }, [clearSmokeTest, smokeInputSignature, smokeTestState.isRunning]);

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
    await startTest(runnerOptions);
  }

  async function handleSmokeTest() {
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
      <header className="app-topbar">
        <div className="app-brand">
          <p className="eyebrow">Load Testing Workspace</p>
          <div className="app-title-row">
            <h1>Load Rift</h1>
            <span className={`status-pill is-${displayedTestStatus}`}>
              {displayedTestStatus.replace("_", " ")}
            </span>
          </div>
          <p className="app-subtitle">
            {collection
              ? `${collection.name} is loaded. Shape the run, inspect the request map, and execute locally with k6.`
              : "Import a Postman collection, derive runtime inputs, and run local k6 checks from one tighter desktop workspace."}
          </p>
        </div>

        <dl className="topbar-stats">
          <div className="topbar-stat">
            <dt>Collection</dt>
            <dd>{collection?.name ?? "No collection loaded"}</dd>
          </div>
          <div className="topbar-stat">
            <dt>Requests</dt>
            <dd>{collection ? formatCount("request", collection.requestCount) : "0 requests"}</dd>
          </div>
          <div className="topbar-stat">
            <dt>Variables</dt>
            <dd>
              {collection
                ? formatCount("variable", collection.runtimeVariables.length)
                : "0 variables"}
            </dd>
          </div>
          <div className="topbar-stat">
            <dt>Runner</dt>
            <dd>{displayedVerdict}</dd>
          </div>
        </dl>
      </header>

      <main
        ref={workspaceShellRef}
        className="workspace-shell"
        style={
          {
            "--sidebar-width": `${sidebarWidth}%`,
          } as CSSProperties
        }
      >
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

        <button
          type="button"
          className={`workspace-divider${isResizingPanes ? " is-resizing" : ""}`}
          aria-label="Resize workspace panes"
          onMouseDown={startPaneResize}
        >
          <span />
        </button>

        <TestHarnessSection
          collection={collection}
          testState={{
            ...testState,
            output: truncateLog(testState.output),
          }}
          configValidation={configValidation}
          canStartTest={canStartTest}
          canSmokeTest={canSmokeTest}
          displayedTestStatus={displayedTestStatus}
          displayedVerdict={displayedVerdict}
          runnerOptions={runnerOptions}
          smokeTestState={smokeTestState}
          emptyRuntimeVariables={emptyRuntimeVariables}
          curlInput={curlInput}
          curlImportState={curlImportState}
          eventLogRef={eventLogRef}
          resultSummaryRef={resultSummaryRef}
          onStartTest={() => void handleStartTest()}
          onSmokeTest={() => void handleSmokeTest()}
          onStopTest={() => void handleStopTest()}
          onValidateConfiguration={() => void handleValidateConfiguration()}
          onRefreshStatus={() => void handleRefreshStatus()}
          onExportLatestReport={() => void handleExportLatestReport()}
          onVusChange={(value) => updateRunnerOption("vus", value)}
          onDurationChange={(value) => updateRunnerOption("duration", value)}
          onRampUpChange={(value) => updateRunnerOption("rampUp", value)}
          onRampUpTimeChange={(value) => updateRunnerOption("rampUpTime", value)}
          onThresholdChange={updateThreshold}
          onAuthTokenChange={(value) => updateRunnerOption("authToken", value)}
          onCurlInputChange={handleCurlInputChange}
          onApplyCurlCommand={applyCurlCommand}
          onRuntimeVariableChange={updateRuntimeVariable}
          onAdvancedOptionsChange={(value) =>
            updateRunnerOption("advancedOptionsJson", value)
          }
        />
      </main>
    </div>
  );
}
