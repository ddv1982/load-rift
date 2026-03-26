import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { CollectionImportSection } from "./components/CollectionImportSection";
import { loadImportMode, saveImportMode } from "./persistence";
import { TestHarnessSection } from "./components/TestHarnessSection";
import type { ImportMode } from "./types";
import { buildReportFileName, formatCount, truncateLog } from "./utils";
import { useCollectionImport } from "../features/import/useCollectionImport";
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

export function App() {
  const api = useLoadRiftApi();
  const {
    state: importState,
    importFromFile,
    importFromUrl,
    reportError,
    reset,
  } = useCollectionImport();
  const {
    state: testState,
    refreshStatus,
    startTest,
    stopTest,
  } = useTestHarness();
  const [importMode, setImportMode] = useState<ImportMode>(() => loadImportMode("file"));
  const [urlInput, setUrlInput] = useState("");
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

  useEffect(() => {
    saveImportMode(importMode);
  }, [importMode]);

  const canStartTest = useMemo(
    () =>
      Boolean(importState.collection) &&
      configValidation.status === "ready" &&
      !testState.isBusy &&
      !testState.isRunning &&
      !testState.isStarting,
    [
      configValidation.status,
      importState.collection,
      testState.isBusy,
      testState.isRunning,
      testState.isStarting,
    ],
  );

  const displayedTestStatus = testState.isStarting ? "starting" : testState.status;
  const displayedVerdict = testState.result
    ? testState.result.status.toUpperCase()
    : displayedTestStatus.toUpperCase();

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

  async function handleUrlImport() {
    await importFromUrl(urlInput);
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
          importMode={importMode}
          collection={collection}
          selectedRequestIds={runnerOptions.selectedRequestIds}
          error={importState.error}
          isLoading={importState.isLoading}
          isPickingFile={isPickingFile}
          urlInput={urlInput}
          onImportModeChange={setImportMode}
          onUrlInputChange={setUrlInput}
          onFileImport={() => void handleFileImport()}
          onUrlImport={() => void handleUrlImport()}
          onReset={reset}
          onClearUrl={() => setUrlInput("")}
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
          displayedTestStatus={displayedTestStatus}
          displayedVerdict={displayedVerdict}
          runnerOptions={runnerOptions}
          emptyRuntimeVariables={emptyRuntimeVariables}
          curlInput={curlInput}
          curlImportState={curlImportState}
          eventLogRef={eventLogRef}
          resultSummaryRef={resultSummaryRef}
          onStartTest={() => void handleStartTest()}
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
