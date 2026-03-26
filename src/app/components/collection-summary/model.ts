import type { RequestInfo } from "../../../lib/loadrift/types";

interface FolderNode {
  id: string;
  name: string;
  depth: number;
  ancestorFolderIds: string[];
  pathLabel: string;
  requestIds: string[];
}

export type CollectionRow =
  | {
      kind: "folder";
      id: string;
      name: string;
      depth: number;
      pathLabel: string;
      requestIds: string[];
      ancestorFolderIds: string[];
    }
  | {
      kind: "request";
      depth: number;
      ancestorFolderIds: string[];
      request: RequestInfo;
    };

export function createFolderId(pathSegments: string[]) {
  return `folder:${JSON.stringify(pathSegments)}`;
}

export function filterRequests(
  requests: RequestInfo[],
  methodFilter: string,
  searchQuery: string,
) {
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();

  return requests.filter((request) => {
    const matchesMethod = methodFilter === "all" || request.method === methodFilter;
    const matchesSearch =
      !normalizedSearchQuery ||
      `${request.folderPath.join(" ")} ${request.name} ${request.url}`
        .toLowerCase()
        .includes(normalizedSearchQuery);

    return matchesMethod && matchesSearch;
  });
}

export function buildCollectionRows(requests: RequestInfo[]): CollectionRow[] {
  const folderIndex = new Map<string, FolderNode>();
  const rows: CollectionRow[] = [];
  const seenFolderIds = new Set<string>();

  for (const request of requests) {
    for (let index = 0; index < request.folderPath.length; index += 1) {
      const folderName = request.folderPath[index];
      if (!folderName) {
        continue;
      }

      const pathSegments = request.folderPath.slice(0, index + 1);
      const folderId = createFolderId(pathSegments);
      const pathLabel = pathSegments.join(" / ");
      let folder = folderIndex.get(folderId) ?? null;

      if (!folder) {
        folder = {
          id: folderId,
          name: folderName,
          depth: index,
          ancestorFolderIds: pathSegments
            .slice(0, -1)
            .map((_, ancestorIndex) => createFolderId(pathSegments.slice(0, ancestorIndex + 1))),
          pathLabel,
          requestIds: [],
        };
        folderIndex.set(folderId, folder);
      }

      folder.requestIds.push(request.id);
    }
  }

  for (const request of requests) {
    const ancestorFolderIds: string[] = [];

    for (let index = 0; index < request.folderPath.length; index += 1) {
      const folderName = request.folderPath[index];
      if (!folderName) {
        continue;
      }

      const folderId = createFolderId(request.folderPath.slice(0, index + 1));
      const folder = folderIndex.get(folderId);
      if (!folder) {
        continue;
      }

      if (!seenFolderIds.has(folderId)) {
        seenFolderIds.add(folderId);
        rows.push({
          kind: "folder",
          id: folder.id,
          name: folder.name,
          depth: folder.depth,
          pathLabel: folder.pathLabel,
          requestIds: folder.requestIds,
          ancestorFolderIds: folder.ancestorFolderIds,
        });
      }

      ancestorFolderIds.push(folderId);
    }

    rows.push({
      kind: "request",
      depth: ancestorFolderIds.length,
      ancestorFolderIds,
      request,
    });
  }

  return rows;
}

export function getVisibleRows(
  rows: CollectionRow[],
  collapsedFolderIds: Set<string>,
) {
  return rows.filter((row) =>
    row.ancestorFolderIds.every((folderId) => !collapsedFolderIds.has(folderId))
  );
}
