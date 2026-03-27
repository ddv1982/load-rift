import type { SmokeTestResponse } from "../../lib/loadrift/types";

interface SmokeTestCardProps {
  result: SmokeTestResponse | null;
  error: string | null;
  isRunning: boolean;
}

export function SmokeTestCard({
  result,
  error,
  isRunning,
}: SmokeTestCardProps) {
  return (
    <section className="panel smoke-test-card">
      <div className="result-summary-header">
        <p className="eyebrow">Smoke Test</p>
        <strong>{isRunning ? "Running" : result ? "Captured" : "Idle"}</strong>
      </div>

      <div className="result-summary-scroll">
        {isRunning ? (
          <p className="panel-copy">
            Running the selected requests once to capture live response samples.
          </p>
        ) : null}

        {!isRunning && error ? (
          <div className="validation-banner is-invalid">
            <strong>Smoke Test Failed</strong>
            <p>{error}</p>
          </div>
        ) : null}

        {!isRunning && !error && !result ? (
          <p className="panel-copy">
            Run a smoke test to execute the selected requests once and inspect
            the response body, headers, and status before starting load.
          </p>
        ) : null}

        {result?.responses.length ? (
          <div className="smoke-test-list">
            {result.responses.map((response) => (
              <article
                key={response.requestId}
                className={`smoke-test-item${response.ok ? "" : " is-failed"}`}
              >
                <div className="smoke-test-item-header">
                  <div>
                    <strong>{response.requestName}</strong>
                    <p>{response.method} {response.url}</p>
                  </div>
                  <div className="smoke-test-item-stats">
                    <span>{response.statusCode ?? "ERR"}</span>
                    <span>{response.durationMs} ms</span>
                  </div>
                </div>

                {response.contentType ? (
                  <p className="smoke-test-meta">
                    <strong>Content-Type:</strong> {response.contentType}
                  </p>
                ) : null}

                {Object.keys(response.responseHeaders).length ? (
                  <details className="smoke-test-details">
                    <summary>Response headers</summary>
                    <pre className="event-log smoke-test-headers">
                      {Object.entries(response.responseHeaders)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join("\n")}
                    </pre>
                  </details>
                ) : null}

                {response.bodyPreview ? (
                  <details className="smoke-test-details" open>
                    <summary>Response preview</summary>
                    <pre className="event-log">{response.bodyPreview}</pre>
                  </details>
                ) : null}

                {response.errorMessage ? (
                  <p className="smoke-test-error">{response.errorMessage}</p>
                ) : null}
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
