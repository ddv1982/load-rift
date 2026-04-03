import { useEffect, useRef, type InputHTMLAttributes } from "react";
import type { CollectionInfo, K6Options } from "../../lib/loadrift/types";
import { formatCount, getRequestWeight } from "../utils";
import { useCollectionSummaryState } from "./collection-summary/useCollectionSummaryState";

interface CollectionSummaryCardProps {
  collection: CollectionInfo | null;
  selectedRequestIds: string[];
  requestWeights: K6Options["requestWeights"];
  trafficMode: K6Options["trafficMode"];
  onSelectionChange: (selectedRequestIds: string[]) => void;
  onRequestWeightChange: (requestId: string, weight: number) => void;
}

function SelectionCheckbox({
  checked,
  indeterminate,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  indeterminate?: boolean;
}) {
  const checkboxRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!checkboxRef.current) {
      return;
    }

    checkboxRef.current.indeterminate = Boolean(indeterminate && !checked);
  }, [checked, indeterminate]);

  return <input ref={checkboxRef} type="checkbox" checked={checked} {...props} />;
}

export function CollectionSummaryCard({
  collection,
  selectedRequestIds,
  requestWeights,
  trafficMode,
  onSelectionChange,
  onRequestWeightChange,
}: CollectionSummaryCardProps) {
  const {
    searchQuery,
    setSearchQuery,
    methodFilter,
    setMethodFilter,
    selectedRequestSet,
    availableMethods,
    filteredRequests,
    folderRows,
    collapsedFolderSet,
    visibleRows,
    allRequestIds,
    visibleRequestIds,
    selectedCount,
    allSelected,
    visibleSelectedCount,
    filteredSelectedCount,
    allFoldersCollapsed,
    updateSelection,
    toggleFolder,
    toggleAllFolders,
  } = useCollectionSummaryState({
    collection,
    selectedRequestIds,
    onSelectionChange,
  });

  const showWeights = trafficMode === "weighted";
  const weightedSelectionCount = (collection?.requests ?? []).filter(
    (request) =>
      selectedRequestSet.has(request.id) && getRequestWeight(request.id, requestWeights) > 0,
  ).length;

  if (!collection) {
    return (
      <article className="summary-card is-empty">
        <p>No imported collection yet.</p>
        <span>
          Import a Postman collection from disk to inspect the extracted
          request summary here.
        </span>
      </article>
    );
  }

  return (
    <article className="summary-card">
      <div className="summary-header">
        <div>
          <p className="eyebrow">Imported Collection</p>
          <h3>{collection.name}</h3>
        </div>

        <div className="summary-badges">
          <span>{formatCount("request", collection.requestCount)}</span>
          <span>{formatCount("folder", collection.folderCount)}</span>
        </div>
      </div>

      <div className="summary-toolbar">
        <label className="field summary-search">
          <span>Search requests</span>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Find by folder, name, or path"
          />
        </label>

        <label className="field summary-filter">
          <span>Method</span>
          <select
            value={methodFilter}
            onChange={(event) => setMethodFilter(event.target.value)}
          >
            <option value="all">All methods</option>
            {availableMethods.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="summary-selection-bar">
        <label className="summary-master-toggle">
          <SelectionCheckbox
            checked={allSelected}
            indeterminate={selectedCount > 0 && !allSelected}
            onChange={(event) => updateSelection(allRequestIds, event.target.checked)}
          />
          <span>Run all imported requests</span>
        </label>

        <div className="summary-selection-actions">
          <button
            type="button"
            className="ghost summary-action-button"
            onClick={() => updateSelection(visibleRequestIds, true)}
            disabled={!visibleRequestIds.length}
          >
            Select visible
          </button>
          <button
            type="button"
            className="ghost summary-action-button"
            onClick={() => onSelectionChange(allRequestIds)}
          >
            Select all
          </button>
          <button
            type="button"
            className="ghost summary-action-button"
            onClick={() => onSelectionChange([])}
          >
            Clear all
          </button>
          <button
            type="button"
            className="ghost summary-action-button"
            onClick={toggleAllFolders}
            disabled={!folderRows.length}
          >
            {allFoldersCollapsed ? "Expand all" : "Collapse all"}
          </button>
        </div>
      </div>

      <div className="summary-meta">
        <span>
          Showing {filteredRequests.length} of {collection.requestCount} requests
        </span>
        <span>
          Running {selectedCount} of {collection.requestCount} requests
          {filteredRequests.length
            ? ` (${visibleSelectedCount} visible, ${filteredSelectedCount} filtered)`
            : ""}
        </span>
        {showWeights ? (
          <span>
            Weighted pool includes {weightedSelectionCount} request
            {weightedSelectionCount === 1 ? "" : "s"}
          </span>
        ) : null}
        <span>{formatCount("runtime variable", collection.runtimeVariables.length)}</span>
      </div>

      <div className="request-table">
        <div className={`request-list-header request-tree-header${showWeights ? " is-weighted" : ""}`}>
          <span>Run</span>
          <span>Collection item</span>
          <span>Resolved URL / Path</span>
          {showWeights ? <span>Weight</span> : null}
        </div>

        {visibleRows.length ? (
          <ul className="request-list request-tree-list">
            {visibleRows.map((row) => {
              if (row.kind === "folder") {
                const selectedDescendants = row.requestIds.filter((requestId) =>
                  selectedRequestSet.has(requestId)
                ).length;
                const fullySelected =
                  row.requestIds.length > 0 &&
                  selectedDescendants === row.requestIds.length;
                const isCollapsed = collapsedFolderSet.has(row.id);

                return (
                  <li
                    key={row.id}
                    className={`request-tree-row request-tree-folder${showWeights ? " is-weighted" : ""}`}
                  >
                    <SelectionCheckbox
                      checked={fullySelected}
                      indeterminate={
                        selectedDescendants > 0 && selectedDescendants < row.requestIds.length
                      }
                      onChange={(event) =>
                        updateSelection(row.requestIds, event.target.checked)
                      }
                      aria-label={`Run folder ${row.name}`}
                    />
                    <div
                      className="request-tree-item request-tree-item-folder"
                      style={{ paddingInlineStart: `${row.depth * 1.1}rem` }}
                    >
                      <button
                        type="button"
                        className="folder-toggle"
                        onClick={() => toggleFolder(row.id)}
                        aria-label={`${isCollapsed ? "Expand" : "Collapse"} folder ${row.name}`}
                        aria-expanded={!isCollapsed}
                      >
                        <span className={`folder-toggle-icon${isCollapsed ? "" : " is-open"}`}>
                          ▸
                        </span>
                        <strong className="request-folder-name">{row.name}</strong>
                      </button>
                      <span className="request-folder-meta">
                        {formatCount("request", row.requestIds.length)}
                      </span>
                    </div>
                    <em className="request-url">{row.pathLabel}</em>
                    {showWeights ? <span className="request-weight-placeholder">—</span> : null}
                  </li>
                );
              }

              const requestWeight = getRequestWeight(row.request.id, requestWeights);

              return (
                <li
                  key={row.request.id}
                  className={`request-tree-row request-tree-request${showWeights ? " is-weighted" : ""}`}
                >
                  <SelectionCheckbox
                    checked={selectedRequestSet.has(row.request.id)}
                    onChange={(event) =>
                      updateSelection([row.request.id], event.target.checked)
                    }
                    aria-label={`Run request ${row.request.name}`}
                  />
                  <div
                    className="request-tree-item"
                    style={{ paddingInlineStart: `${row.depth * 1.1}rem` }}
                  >
                    <strong className="request-method">{row.request.method}</strong>
                    <span className="request-name">{row.request.name}</span>
                  </div>
                  <em className="request-url">
                    {row.request.url || "No URL extracted"}
                  </em>
                  {showWeights ? (
                    <label className="request-weight-field">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={requestWeight}
                        disabled={!selectedRequestSet.has(row.request.id)}
                        onChange={(event) =>
                          onRequestWeightChange(
                            row.request.id,
                            Number(event.target.value) || 1,
                          )
                        }
                        aria-label={`Weight for ${row.request.name}`}
                      />
                    </label>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="summary-empty-state">
            <p>No requests match the current filters.</p>
            <span>Clear the search or switch the method filter to see more.</span>
          </div>
        )}
      </div>

      {collection.runtimeVariables.length ? (
        <div className="variable-summary">
          <p className="eyebrow">Runtime Variables</p>
          <div className="summary-badges">
            {collection.runtimeVariables.map((variable) => (
              <span key={variable.key}>
                {variable.key}
                {variable.defaultValue ? " (default)" : ""}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}
