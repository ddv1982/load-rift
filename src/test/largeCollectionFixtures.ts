import type { CollectionInfo, RequestInfo } from "../lib/loadrift/types";

interface LargeCollectionOptions {
  requestCount?: number;
  folderSize?: number;
  includeFolders?: boolean;
}

export function createLargeCollectionInfo({
  requestCount = 1_000,
  folderSize = 100,
  includeFolders = true,
}: LargeCollectionOptions = {}): CollectionInfo {
  const requests: RequestInfo[] = Array.from(
    { length: requestCount },
    (_, index) => {
      const folderIndex = Math.floor(index / folderSize);

      return {
        id: `request-${index}`,
        name: `Request ${index}`,
        method: index % 5 === 0 ? "POST" : "GET",
        url: `{{environment}}/folders/${folderIndex}/items/${index}?page={{page}}`,
        folderPath: includeFolders ? [`Folder ${folderIndex}`] : [],
      };
    },
  );

  return {
    name: "Large Fixture Collection",
    requestCount,
    folderCount: includeFolders ? Math.ceil(requestCount / folderSize) : 0,
    requests,
    runtimeVariables: [
      { key: "environment" },
      { key: "page", defaultValue: "1" },
    ],
  };
}
