import { bench, describe } from "vitest";
import { createLargeCollectionInfo } from "../test/largeCollectionFixtures";
import {
  buildCollectionRows,
  filterRequests,
  getVisibleRows,
} from "../app/components/collection-summary/model";

const largeCollection = createLargeCollectionInfo({
  requestCount: 5_000,
  folderSize: 100,
});

describe("large collection summary model", () => {
  bench("builds folder/request rows for 5,000 requests", () => {
    buildCollectionRows(largeCollection.requests);
  });

  bench("filters, expands visible rows, and slices initial render rows", () => {
    const filtered = filterRequests(largeCollection.requests, "GET", "items");
    const rows = buildCollectionRows(filtered);
    const visibleRows = getVisibleRows(rows, new Set());

    visibleRows.slice(0, 250);
  });
});
