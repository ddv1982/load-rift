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
    <section className="panel import-panel">
      <div className="section-heading">
        <div className="section-heading-copy">
          <p className="panel-kicker">Step 1</p>
          <h2>Collection Import</h2>
          <p className="section-copy">
            Load a collection from disk and keep the extracted request map
            visible while you configure the run.
          </p>
        </div>
      </div>

      <div className="import-callout">
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

      <CollectionSummaryCard
        collection={collection}
        selectedRequestIds={selectedRequestIds}
        onSelectionChange={onSelectionChange}
      />

      {error ? <p className="inline-error">{error}</p> : null}
    </section>
  );
}
