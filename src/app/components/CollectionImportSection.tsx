import type { CollectionInfo } from "../../lib/loadrift/types";
import { CollectionSummaryCard } from "./CollectionSummaryCard";

interface CollectionImportSectionProps {
  collection: CollectionInfo | null;
  selectedRequestIds: string[];
  error: string | null;
  isLoading: boolean;
  isPickingFile: boolean;
  onFileImport: () => void;
  onReset: () => void;
  onSelectionChange: (selectedRequestIds: string[]) => void;
}

export function CollectionImportSection({
  collection,
  selectedRequestIds,
  error,
  isLoading,
  isPickingFile,
  onFileImport,
  onReset,
  onSelectionChange,
}: CollectionImportSectionProps) {
  return (
    <section className="panel import-panel workflow-panel">
      <div className="section-heading section-heading-tight">
        <div className="section-heading-copy">
          <p className="panel-kicker">Step 1 · Source</p>
          <h2>Import a collection</h2>
          <p className="section-copy">
            Start by loading a Postman collection. Once it is in, keep request
            selection close by but out of the way of the run setup.
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
            Use the file picker for the fastest path, then refine request scope
            and variables only when you need to.
          </p>
        </div>
        <div className="action-row action-row-compact">
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

      <details className="progressive-panel" open={Boolean(collection)}>
        <summary>
          {collection
            ? "Collection details and request selection"
            : "What appears after import"}
        </summary>
        <div className="progressive-panel-body">
          <CollectionSummaryCard
            collection={collection}
            selectedRequestIds={selectedRequestIds}
            onSelectionChange={onSelectionChange}
          />
        </div>
      </details>

      {error ? <p className="inline-error">{error}</p> : null}
    </section>
  );
}
