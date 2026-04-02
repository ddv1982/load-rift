import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { CollectionInfo } from "../../../lib/loadrift/types";
import {
  createCollectionStorageKey,
  loadCollectionFilters,
  saveCollectionFilters,
} from "../../persistence";
import {
  buildCollectionRows,
  filterRequests,
  getVisibleRows,
  type CollectionRow,
} from "./model";

interface UseCollectionSummaryStateOptions {
  collection: CollectionInfo | null;
  selectedRequestIds: string[];
  onSelectionChange: (selectedRequestIds: string[]) => void;
}

interface UseCollectionSummaryStateResult {
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  methodFilter: string;
  setMethodFilter: (value: string) => void;
  selectedRequestSet: Set<string>;
  availableMethods: string[];
  filteredRequests: CollectionInfo["requests"];
  folderRows: Extract<CollectionRow, { kind: "folder" }>[];
  collapsedFolderSet: Set<string>;
  visibleRows: CollectionRow[];
  allRequestIds: string[];
  visibleRequestIds: string[];
  selectedCount: number;
  allSelected: boolean;
  visibleSelectedCount: number;
  filteredSelectedCount: number;
  allFoldersCollapsed: boolean;
  updateSelection: (requestIds: string[], nextChecked: boolean) => void;
  toggleFolder: (folderId: string) => void;
  toggleAllFolders: () => void;
}

export function useCollectionSummaryState({
  collection,
  selectedRequestIds,
  onSelectionChange,
}: UseCollectionSummaryStateOptions): UseCollectionSummaryStateResult {
  const [searchQuery, setSearchQuery] = useState("");
  const [methodFilter, setMethodFilter] = useState("all");
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<string[]>([]);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const collectionKey = useMemo(
    () => (collection ? createCollectionStorageKey(collection) : null),
    [collection],
  );
  const selectedRequestSet = useMemo(() => new Set(selectedRequestIds), [selectedRequestIds]);
  const {
    availableMethods,
    filteredRequests,
    rows,
    folderRows,
    allRequestIds,
  } = useMemo(() => {
    const requests = collection?.requests ?? [];
    const availableMethods = [...new Set(requests.map((request) => request.method))].sort();
    const filteredRequests = filterRequests(requests, methodFilter, deferredSearchQuery);
    const rows = buildCollectionRows(filteredRequests);
    const folderRows = rows.filter(
      (row): row is Extract<CollectionRow, { kind: "folder" }> => row.kind === "folder",
    );
    const allRequestIds = requests.map((request) => request.id);

    return {
      availableMethods,
      filteredRequests,
      rows,
      folderRows,
      allRequestIds,
    };
  }, [collection, deferredSearchQuery, methodFilter]);
  const { collapsedFolderSet, visibleRows, visibleRequestIds } = useMemo(() => {
    const collapsedFolderSet = new Set(collapsedFolderIds);
    const visibleRows = getVisibleRows(rows, collapsedFolderSet);
    const visibleRequestIds = visibleRows
      .filter((row): row is Extract<CollectionRow, { kind: "request" }> => row.kind === "request")
      .map((row) => row.request.id);

    return {
      collapsedFolderSet,
      visibleRows,
      visibleRequestIds,
    };
  }, [collapsedFolderIds, rows]);

  useEffect(() => {
    if (!collectionKey) {
      setSearchQuery("");
      setMethodFilter("all");
      return;
    }

    const persistedFilters = loadCollectionFilters(collectionKey);
    if (!persistedFilters) {
      setSearchQuery("");
      setMethodFilter("all");
      return;
    }

    setSearchQuery(persistedFilters.searchQuery);
    setMethodFilter(persistedFilters.methodFilter);
  }, [collectionKey]);

  useEffect(() => {
    if (!collectionKey) {
      return;
    }

    saveCollectionFilters({
      collectionKey,
      methodFilter,
      searchQuery,
    });
  }, [collectionKey, methodFilter, searchQuery]);

  useEffect(() => {
    const folderIds = new Set(folderRows.map((row) => row.id));
    setCollapsedFolderIds((previous) => previous.filter((folderId) => folderIds.has(folderId)));
  }, [folderRows]);

  const selectedCount = selectedRequestIds.length;
  const allSelected = collection ? selectedCount === collection.requestCount : false;
  const visibleSelectedCount = visibleRequestIds.filter((requestId) =>
    selectedRequestSet.has(requestId)
  ).length;
  const filteredSelectedCount = filteredRequests.filter((request) =>
    selectedRequestSet.has(request.id)
  ).length;
  const allFoldersCollapsed =
    folderRows.length > 0 && folderRows.every((row) => collapsedFolderSet.has(row.id));

  function updateSelection(requestIds: string[], nextChecked: boolean) {
    if (!collection) {
      return;
    }

    const nextSelected = new Set(selectedRequestIds);
    for (const requestId of requestIds) {
      if (nextChecked) {
        nextSelected.add(requestId);
      } else {
        nextSelected.delete(requestId);
      }
    }

    onSelectionChange(
      collection.requests
        .map((request) => request.id)
        .filter((requestId) => nextSelected.has(requestId)),
    );
  }

  function toggleFolder(folderId: string) {
    setCollapsedFolderIds((previous) =>
      previous.includes(folderId)
        ? previous.filter((value) => value !== folderId)
        : [...previous, folderId]
    );
  }

  function toggleAllFolders() {
    setCollapsedFolderIds(allFoldersCollapsed ? [] : folderRows.map((row) => row.id));
  }

  return {
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
  };
}
