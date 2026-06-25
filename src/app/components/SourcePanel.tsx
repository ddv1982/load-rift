import type { RefObject } from "react";
import type { CollectionInfo, K6Options } from "../../lib/loadrift/types";
import { CollectionImportSection } from "./CollectionImportSection";

interface SourcePanelProps {
  panelRef: RefObject<HTMLDivElement | null>;
  workflowTabsId: string;
  isActive: boolean;
  collection: CollectionInfo | null;
  selectedRequestIds: string[];
  requestWeights: Record<string, number>;
  trafficMode: K6Options["trafficMode"];
  error: string | null;
  isLoading: boolean;
  isPickingFile: boolean;
  isSourceChangeDisabled: boolean;
  onFileImport: () => void;
  onReset: () => void;
  onSelectionChange: (requestIds: string[]) => void;
  onRequestWeightChange: (requestId: string, weight: number) => void;
}

export function SourcePanel({
  panelRef,
  workflowTabsId,
  isActive,
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
}: SourcePanelProps) {
  return (
    <div
      ref={panelRef}
      role="tabpanel"
      id={`${workflowTabsId}-source-panel`}
      aria-labelledby={`${workflowTabsId}-source-tab`}
      hidden={!isActive}
    >
      <CollectionImportSection
        collection={collection}
        selectedRequestIds={selectedRequestIds}
        requestWeights={requestWeights}
        trafficMode={trafficMode}
        error={error}
        isLoading={isLoading}
        isPickingFile={isPickingFile}
        isSourceChangeDisabled={isSourceChangeDisabled}
        onFileImport={onFileImport}
        onReset={onReset}
        onSelectionChange={onSelectionChange}
        onRequestWeightChange={onRequestWeightChange}
      />
    </div>
  );
}
