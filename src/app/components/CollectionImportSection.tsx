import { useId, useRef, type KeyboardEvent } from "react";
import type { CollectionInfo } from "../../lib/loadrift/types";
import type { ImportMode } from "../types";
import { CollectionSummaryCard } from "./CollectionSummaryCard";

interface CollectionImportSectionProps {
  importMode: ImportMode;
  collection: CollectionInfo | null;
  selectedRequestIds: string[];
  error: string | null;
  isLoading: boolean;
  isPickingFile: boolean;
  urlInput: string;
  onImportModeChange: (mode: ImportMode) => void;
  onUrlInputChange: (value: string) => void;
  onFileImport: () => void;
  onUrlImport: () => void;
  onReset: () => void;
  onClearUrl: () => void;
  onSelectionChange: (selectedRequestIds: string[]) => void;
}

export function CollectionImportSection({
  importMode,
  collection,
  selectedRequestIds,
  error,
  isLoading,
  isPickingFile,
  urlInput,
  onImportModeChange,
  onUrlInputChange,
  onFileImport,
  onUrlImport,
  onReset,
  onClearUrl,
  onSelectionChange,
}: CollectionImportSectionProps) {
  const tabListId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const modes: ImportMode[] = ["file", "url"];

  function focusTab(index: number) {
    tabRefs.current[index]?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex = index;

    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % modes.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + modes.length) % modes.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = modes.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextMode = modes[nextIndex];
    if (!nextMode) {
      return;
    }

    onImportModeChange(nextMode);
    focusTab(nextIndex);
  }

  return (
    <section className="panel import-panel">
      <div className="section-heading">
        <div className="section-heading-copy">
          <p className="panel-kicker">Step 1</p>
          <h2>Collection Import</h2>
          <p className="section-copy">
            Load a collection from disk or URL and keep the extracted request
            map visible while you configure the run.
          </p>
        </div>

        <div className="segmented-control" role="tablist" aria-label="Import mode">
          {modes.map((mode, index) => {
            const isActive = importMode === mode;
            const tabId = `${tabListId}-${mode}-tab`;
            const panelId = `${tabListId}-${mode}-panel`;
            const label = mode === "file" ? "File" : "URL";

            return (
              <button
                key={mode}
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
                onClick={() => onImportModeChange(mode)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        className="import-callout"
        role="tabpanel"
        id={`${tabListId}-file-panel`}
        aria-labelledby={`${tabListId}-file-tab`}
        hidden={importMode !== "file"}
      >
        <div>
          <p className="callout-title">Bring in a Postman collection</p>
          <p className="panel-copy">
            Use the file picker for the fastest flow, then inspect requests
            and runtime variables directly below.
          </p>
        </div>
        <div className="action-row">
          <button
            type="button"
            className="primary"
            onClick={onFileImport}
            disabled={isLoading || isPickingFile}
          >
            {isPickingFile ? "Selecting..." : "Choose Postman Collection"}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={onReset}
            disabled={isLoading}
          >
            Reset
          </button>
        </div>
      </div>

      <div
        className="stack import-stack"
        role="tabpanel"
        id={`${tabListId}-url-panel`}
        aria-labelledby={`${tabListId}-url-tab`}
        hidden={importMode !== "url"}
      >
        <label className="field">
          <span>Collection URL</span>
          <input
            type="url"
            value={urlInput}
            onChange={(event) => onUrlInputChange(event.target.value)}
            placeholder="https://api.getpostman.com/collections/..."
          />
        </label>
        <div className="action-row">
          <button
            type="button"
            className="primary"
            onClick={onUrlImport}
            disabled={isLoading || !urlInput.trim()}
          >
            Import From URL
          </button>
          <button
            type="button"
            className="ghost"
            onClick={onClearUrl}
            disabled={isLoading}
          >
            Clear
          </button>
        </div>
      </div>

      <CollectionSummaryCard
        collection={collection}
        selectedRequestIds={selectedRequestIds}
        onSelectionChange={onSelectionChange}
      />

      {error ? <p className="inline-error">{error}</p> : null}
    </section>
  );
}
