import type { RefObject } from "react";
import type { TestResult, TestResultSource } from "../../lib/loadrift/types";

interface ResultNotice {
  tone: "error" | "success";
  message: string;
}

interface LatestResultCardProps {
  result: TestResult | null;
  finishReason: string | null;
  resultSource: TestResultSource | null;
  summaryIssue: string | null;
  error: string | null;
  notice: ResultNotice | null;
  resultSummaryRef: RefObject<HTMLDivElement | null>;
  onExportLatestReport: () => void;
}

function formatResultSource(source: TestResultSource | null) {
  if (source === "liveMetricsFallback") {
    return "Live metrics fallback";
  }

  if (source === "summary") {
    return "Structured summary";
  }

  return null;
}

function ExportNotice({ notice }: { notice: ResultNotice | null }) {
  if (!notice) {
    return null;
  }

  return (
    <p
      className={`inline-note export-notice${notice.tone === "success" ? " is-success" : " is-error"}`}
      role={notice.tone === "error" ? "alert" : "status"}
      aria-atomic="true"
    >
      {notice.message}
    </p>
  );
}

export function LatestResultCard({
  result,
  finishReason,
  resultSource,
  summaryIssue,
  error,
  notice,
  resultSummaryRef,
  onExportLatestReport,
}: LatestResultCardProps) {
  if (!result) {
    return (
      <div className="result-summary result-summary-empty">
        <div className="result-summary-header">
          <div>
            <p className="eyebrow">Latest Result</p>
            <h3>Report</h3>
          </div>
          <div className="export-action-group">
            <button
              type="button"
              className="ghost"
              onClick={onExportLatestReport}
              disabled
            >
              Export Latest Report
            </button>
            <p className="inline-note export-helper">
              Run a test before exporting the retained k6 report.
            </p>
          </div>
        </div>
        <div className="result-summary-scroll">
          <p className="panel-copy">
            Run a test to capture the latest request totals, failure count, and
            exported report.
          </p>
          <ExportNotice notice={notice} />
        </div>
      </div>
    );
  }

  return (
    <div className="result-summary">
      <div className="result-summary-header">
        <div>
          <p className="eyebrow">Latest Result</p>
          <h3>Report</h3>
        </div>
        <div className="result-summary-actions">
          <strong>{result.status}</strong>
          <div className="export-action-group">
            <button
              type="button"
              className="ghost"
              onClick={onExportLatestReport}
            >
              Export Latest Report
            </button>
            <p className="inline-note export-helper">Exports the latest retained k6 report.</p>
          </div>
        </div>
      </div>

      <ExportNotice notice={notice} />

      <div ref={resultSummaryRef} className="result-summary-scroll">
        {finishReason || resultSource || error ? (
          <div className="threshold-list">
            {finishReason ? (
              <p>
                <span>Finish reason</span>
                <strong>{finishReason}</strong>
              </p>
            ) : null}
            {resultSource ? (
              <p>
                <span>Result source</span>
                <strong>{formatResultSource(resultSource)}</strong>
              </p>
            ) : null}
            {resultSource === "liveMetricsFallback" ? (
              <p>
                <span>Fallback context</span>
                <strong>
                  {summaryIssue ?? "Structured k6 summary could not be processed."}
                </strong>
              </p>
            ) : null}
            {error ? (
              <p>
                <span>Primary k6 error</span>
                <strong>{error}</strong>
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="result-summary-grid">
          <p>
            <span>Total requests</span>
            <strong>{result.metrics.totalRequests}</strong>
          </p>
          <p>
            <span>Failed requests</span>
            <strong>{result.metrics.failedRequests}</strong>
          </p>
          <p>
            <span>Avg response</span>
            <strong>{Math.round(result.metrics.avgResponseTime)} ms</strong>
          </p>
          <p>
            <span>P95 response</span>
            <strong>{Math.round(result.metrics.p95ResponseTime)} ms</strong>
          </p>
          <p>
            <span>Max response</span>
            <strong>{Math.round(result.metrics.maxResponseTime)} ms</strong>
          </p>
          <p>
            <span>Req/s</span>
            <strong>{result.metrics.requestsPerSecond.toFixed(2)}</strong>
          </p>
        </div>

        {result.thresholds.length ? (
          <div className="threshold-list">
            {result.thresholds.map((threshold) => (
              <p key={threshold.name}>
                <span>{threshold.name}</span>
                <strong
                  className={threshold.passed ? "threshold-pass" : "threshold-fail"}
                >
                  {threshold.passed ? "Passed" : "Failed"}
                </strong>
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
