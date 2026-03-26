import type { RefObject } from "react";
import type { TestResult } from "../../lib/loadrift/types";

interface LatestResultCardProps {
  result: TestResult | null;
  resultSummaryRef: RefObject<HTMLDivElement | null>;
}

export function LatestResultCard({
  result,
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
