import { useEffect, useRef, useState } from "react";
import type { TestResult } from "../../lib/loadrift/types";
import { loadSidebarWidth, saveSidebarWidth } from "../persistence";

interface UseWorkspaceLayoutOptions {
  output: string;
  result: TestResult | null;
}

export function useWorkspaceLayout({
  output,
  result,
}: UseWorkspaceLayoutOptions) {
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth(34));
  const [isResizingPanes, setIsResizingPanes] = useState(false);
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

  useEffect(() => {
    if (!isResizingPanes) {
      return;
    }

    function handleMouseMove(event: MouseEvent) {
      const workspaceNode = workspaceShellRef.current;
      if (!workspaceNode) {
        return;
      }

      const bounds = workspaceNode.getBoundingClientRect();
      const nextWidth = ((event.clientX - bounds.left) / bounds.width) * 100;
      setSidebarWidth(Math.max(24, Math.min(46, nextWidth)));
    }

    function handleMouseUp() {
      setIsResizingPanes(false);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizingPanes]);

  useEffect(() => {
    saveSidebarWidth(sidebarWidth);
  }, [sidebarWidth]);

  return {
    sidebarWidth,
    isResizingPanes,
    workspaceShellRef,
    eventLogRef,
    resultSummaryRef,
    startPaneResize: () => setIsResizingPanes(true),
  };
}
