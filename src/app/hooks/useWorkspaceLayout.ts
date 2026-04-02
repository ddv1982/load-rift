import { useEffect, useRef } from "react";
import type { TestResult } from "../../lib/loadrift/types";

interface UseWorkspaceLayoutOptions {
  output: string;
  result: TestResult | null;
}

export function useWorkspaceLayout({
  output,
  result,
}: UseWorkspaceLayoutOptions) {
  const workspaceShellRef = useRef<HTMLElement | null>(null);
  const eventLogRef = useRef<HTMLPreElement | null>(null);
  const resultSummaryRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = eventLogRef.current;
    if (!node) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [output]);

  useEffect(() => {
    const node = resultSummaryRef.current;
    if (!node) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [result]);

  return {
    workspaceShellRef,
    eventLogRef,
    resultSummaryRef,
  };
}
