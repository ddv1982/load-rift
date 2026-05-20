import type { RefObject } from "react";
import type { TestResultSource } from "../../lib/loadrift/types";

interface MonitorNotice {
  tone: "error" | "success";
  message: string;
}

interface LiveRunMonitorCardProps {
  output: string;
  error: string | null;
  finishReason: string | null;
  resultSource: TestResultSource | null;
  summaryIssue: string | null;
  notice: MonitorNotice | null;
  eventLogRef: RefObject<HTMLPreElement | null>;
  onExportLatestReport: () => void;
}

export function LiveRunMonitorCard({
  output,
  error,
  finishReason,
  resultSource,
  summaryIssue,
  notice,
  eventLogRef,
  onExportLatestReport,
}: LiveRunMonitorCardProps) {
  return (
    <div className="monitor-card monitor-card-live">
      <div className="monitor-header">
        <div>
          <p className="eyebrow">Live Run</p>
          <h3>Monitor</h3>
        </div>
        <button
          type="button"
          className="ghost"
          onClick={onExportLatestReport}
        >
          Export Latest Report
        </button>
      </div>

      <p className="panel-copy">
        Live runner output appears here as the test progresses so you can track
        status, thresholds, and failure signals without leaving the workspace.
      </p>

      <pre ref={eventLogRef} className="event-log event-log-tall">
        <code>{output}</code>
      </pre>

      {error ? <p className="inline-error">Primary k6 error: {error}</p> : null}
      {resultSource === "liveMetricsFallback" ? (
        <p className="inline-note is-error">
          Latest result uses live metrics fallback because the structured k6 summary could not be processed
          {summaryIssue ? `: ${summaryIssue}` : "."}
        </p>
      ) : null}
      {finishReason ? <p className="inline-note">Finish reason: {finishReason}</p> : null}
      {notice ? (
        <p
          className={`inline-note${notice.tone === "success" ? " is-success" : " is-error"}`}
          aria-live="polite"
        >
          {notice.message}
        </p>
      ) : null}
    </div>
  );
}
