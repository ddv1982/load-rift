import { describe, expect, it } from "vitest";
import { appendLogOutput, truncateLogTail } from "./outputLog";

const TRUNCATION_NOTICE =
  "[Load Rift truncated earlier k6 output to keep the app responsive.]\n";

describe("output log helpers", () => {
  it("keeps short logs unchanged", () => {
    expect(truncateLogTail("line one\nline two\n")).toBe("line one\nline two\n");
  });

  it("keeps the latest log tail when appending large output", () => {
    const output = appendLogOutput("a".repeat(140 * 1024), "latest line");

    expect(output.length).toBeLessThanOrEqual(128 * 1024);
    expect(output.startsWith(TRUNCATION_NOTICE)).toBe(true);
    expect(output.endsWith("latest line")).toBe(true);
  });
});
