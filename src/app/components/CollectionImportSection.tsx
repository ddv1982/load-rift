import type { K6Options, CollectionInfo } from "../../lib/loadrift/types";
import { CollectionSummaryCard } from "./CollectionSummaryCard";

interface CollectionImportSectionProps {
  collection: CollectionInfo | null;
  selectedRequestIds: string[];
  requestWeights: K6Options["requestWeights"];
  trafficMode: K6Options["trafficMode"];
  error: string | null;
  isLoading: boolean;
  isPickingFile: boolean;
  isSourceChangeDisabled: boolean;
  onFileImport: () => void;
  onReset: () => void;
  onSelectionChange: (selectedRequestIds: string[]) => void;
  onRequestWeightChange: (requestId: string, weight: number) => void;
}

export function CollectionImportSection({
  collection,
  selectedRequestIds,
  requestWeights,
  trafficMode,
  error,
  isLoading,
  isPickingFile,
  isSourceChangeDisabled,
  onFileImport,
  onReset,
  onSelectionChange,
  onRequestWeightChange,
}: CollectionImportSectionProps) {
  return (
    <section
      className={`panel import-panel workflow-panel source-panel${collection ? " is-complete" : " is-current"}`}
    >
      <div className="section-heading section-heading-tight">
        <div className="section-heading-copy">
          <p className="panel-kicker">Step 1 · Source</p>
          <h2>Import a collection</h2>
          <p className="section-copy">
            Load a Postman collection, then refine request scope only when
            needed.
          </p>
        </div>

        <span className={`section-state-pill${collection ? " is-ready" : ""}`}>
          {collection ? "Collection loaded" : "Waiting for file"}
        </span>
      </div>

      <div className="import-callout import-callout-focused">
        <div>
          <p className="callout-title">Bring in a Postman collection</p>
          <p className="panel-copy">
            Use the picker, then move on to configuration.
          </p>
        </div>
        <div className="action-row action-row-compact">
          <button
            type="button"
            className="primary"
            onClick={onFileImport}
            disabled={isSourceChangeDisabled || isLoading || isPickingFile}
          >
            {isPickingFile ? "Selecting..." : "Choose Postman Collection"}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={onReset}
            disabled={isSourceChangeDisabled || isLoading || !collection}
          >
            Reset
          </button>
        </div>
      </div>

      <details className="progressive-panel" open={Boolean(collection)}>
        <summary>{collection ? "Collection details" : "After import"}</summary>
        <div className="progressive-panel-body">
          <CollectionSummaryCard
            collection={collection}
            selectedRequestIds={selectedRequestIds}
            requestWeights={requestWeights}
            trafficMode={trafficMode}
            onSelectionChange={onSelectionChange}
            onRequestWeightChange={onRequestWeightChange}
          />
        </div>
      </details>

      {error ? <p className="inline-error">{error}</p> : null}
    </section>
  );
}
