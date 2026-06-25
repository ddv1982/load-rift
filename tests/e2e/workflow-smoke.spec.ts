import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type {
  RunErrorEvent,
  RunMetricsEvent,
  TestCompletion,
  TestResult,
} from "../../src/lib/loadrift/types";

const screenshotDir = resolve("docs/quality/screenshots");

async function captureWorkflowScreenshot(page: Page, name: string) {
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({
    path: resolve(screenshotDir, name),
    fullPage: true,
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const metrics = {
      activeVus: 0,
      totalRequests: 12,
      failedRequests: 0,
      errorRate: 0,
      avgResponseTime: 118,
      p50ResponseTime: 102,
      p95ResponseTime: 188,
      maxResponseTime: 240,
      requestsPerSecond: 4.8,
    };
    const result: TestResult = {
      status: "passed",
      metrics,
      thresholds: [
        {
          name: "http_req_duration p95",
          passed: true,
          actual: 188,
          threshold: 2000,
        },
      ],
    };
    const listeners = {
      output: [] as Array<(payload: string) => void>,
      metrics: [] as Array<(payload: RunMetricsEvent) => void>,
      complete: [] as Array<(payload: TestCompletion) => void>,
      error: [] as Array<(payload: RunErrorEvent) => void>,
    };
    const collection = {
      name: "Browser Smoke Collection",
      requestCount: 1,
      folderCount: 0,
      runtimeVariables: [],
      requests: [
        {
          id: "browser-smoke-request",
          name: "Browser smoke request",
          method: "GET",
          url: "https://api.example.com/browser-smoke",
          folderPath: [],
        },
      ],
    };
    const removeListener =
      <TPayload>(callbacks: Array<(payload: TPayload) => void>) =>
      (callback: (payload: TPayload) => void) =>
      () => {
        const index = callbacks.indexOf(callback);
        if (index >= 0) {
          callbacks.splice(index, 1);
        }
      };

    window.__LOADRIFT_E2E_API__ = {
      selectAndImportCollection: () => Promise.resolve(collection),
      validateTestConfiguration: () =>
        Promise.resolve({
          ready: true,
          message: "Configuration looks ready to run.",
        }),
      smokeTestRequests: () =>
        Promise.resolve({
          responses: [
            {
              requestId: "browser-smoke-request",
              requestName: "Browser smoke request",
              method: "GET",
              url: "https://api.example.com/browser-smoke",
              statusCode: 200,
              durationMs: 41,
              ok: true,
              contentType: "application/json",
              responseHeaders: {
                "content-type": "application/json",
              },
              bodyPreview: '{"ok":true}',
              errorMessage: null,
            },
          ],
        }),
      startTest: (input) => {
        const runId = input.runId ?? "browser-smoke-run";
        window.setTimeout(() => {
          for (const callback of listeners.output) {
            callback("browser smoke run completed\n");
          }
          for (const callback of listeners.metrics) {
            callback({ runId, metrics });
          }
          for (const callback of listeners.complete) {
            callback({
              runId,
              runState: "completed",
              finishReason: "completed",
              metrics,
              result,
              resultSource: "summary",
              summaryIssue: null,
              errorMessage: null,
            });
          }
        }, 50);

        return Promise.resolve({ runId });
      },
      stopTest: () => Promise.resolve(),
      selectAndExportReport: () =>
        Promise.resolve({
          savePath: "/tmp/load-rift-browser-smoke.html",
        }),
      getTestStatus: () =>
        Promise.resolve({
          runId: null,
          status: "idle",
          isRunning: false,
          metrics: null,
          result: null,
          finishReason: null,
          errorMessage: null,
          resultSource: null,
          summaryIssue: null,
        }),
      onK6Output: (callback) => {
        listeners.output.push(callback);
        return Promise.resolve(removeListener(listeners.output)(callback));
      },
      onK6Metrics: (callback) => {
        listeners.metrics.push(callback);
        return Promise.resolve(removeListener(listeners.metrics)(callback));
      },
      onK6Complete: (callback) => {
        listeners.complete.push(callback);
        return Promise.resolve(removeListener(listeners.complete)(callback));
      },
      onK6Error: (callback) => {
        listeners.error.push(callback);
        return Promise.resolve(removeListener(listeners.error)(callback));
      },
    };
  });
});

test("covers import, configure, smoke, load, and export in a browser", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("button", { name: "Choose Postman Collection" }),
  ).toBeVisible();
  await captureWorkflowScreenshot(
    page,
    "2026-06-25-browser-smoke-before-import.png",
  );

  await page.getByRole("button", { name: "Choose Postman Collection" }).click();
  await expect(page.getByText("Configuration looks ready to run.")).toBeVisible(
    {
      timeout: 5_000,
    },
  );
  await page.getByRole("tab", { name: /Source/ }).click();
  await expect(page.getByText("Collection loaded")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Browser Smoke Collection" }),
  ).toBeVisible();
  await captureWorkflowScreenshot(
    page,
    "2026-06-25-browser-smoke-after-import.png",
  );

  await page.getByRole("tab", { name: /Configure/ }).click();
  await expect(
    page.getByText("Configuration looks ready to run."),
  ).toBeVisible();
  await page.getByLabel("Virtual users").fill("2");
  await page.getByLabel("Duration").fill("30s");
  await page.getByLabel("Base URL").fill("https://api.example.com");

  await page.getByRole("tab", { name: /Run/ }).click();
  const runPanel = page.getByRole("tabpanel", { name: /Run/ });
  await expect(page.getByRole("button", { name: "Smoke Test" })).toBeEnabled();
  await page.getByRole("button", { name: "Smoke Test" }).click();
  await expect(runPanel.getByText("Browser smoke request")).toBeVisible();
  await expect(runPanel.getByText('{"ok":true}')).toBeVisible();

  await expect(page.getByRole("button", { name: "Start Test" })).toBeEnabled();
  await page.getByRole("button", { name: "Start Test" }).click();
  await expect(page.getByText("browser smoke run completed")).toBeVisible();
  await expect(page.getByText("Structured summary")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export Latest Report" }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "Export Latest Report" }).click();
  await expect(
    page.getByText("Report saved to /tmp/load-rift-browser-smoke.html."),
  ).toBeVisible();
  await captureWorkflowScreenshot(
    page,
    "2026-06-25-browser-smoke-after-export.png",
  );
});
