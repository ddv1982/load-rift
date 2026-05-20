import type { RefObject } from "react";
import type { TestResult, TestResultSource } from "../../lib/loadrift/types";

interface LatestResultCardProps {
  result: TestResult | null;
  finishReason: string | null;
  resultSource: TestResultSource | null;
  summaryIssue: string | null;
  error: string | null;
  resultSummaryRef: RefObject<HTMLDivElement | null>;
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

export function LatestResultCard({
  result,
  finishReason,
  resultSource,
  summaryIssue,
  error,
  resultSummaryRef,
}: LatestResultCardProps) {
  if (!result) {
    return (
      <div className="result-summary result-summary-empty">
        <div className="result-summary-header">
          <p className="eyebrow">Latest Result</p>
        </div>
        <div className="result-summary-scroll">
          <p className="panel-copy">
            Run a test to capture the latest request totals, failure count, and
            exported report.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="result-summary">
      <div className="result-summary-header">
        <p className="eyebrow">Latest Result</p>
        <strong>{result.status}</strong>
      </div>

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
