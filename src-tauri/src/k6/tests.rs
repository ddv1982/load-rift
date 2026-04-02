use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::{process, report, summary};
use crate::models::{LiveMetrics, TestMetrics, TestResult, TestResultStatus, TestStatus};
use crate::state::{AppState, RunningTest};

fn summary_report_result() -> TestResult {
    TestResult {
        status: TestResultStatus::Passed,
        metrics: TestMetrics {
            total_requests: 12,
            failed_requests: 0,
            avg_response_time: 82,
            p50_response_time: 70,
            p95_response_time: 110,
            max_response_time: 120,
            requests_per_second: 3.5,
        },
        thresholds: Vec::new(),
    }
}

fn sample_result(status: TestResultStatus) -> TestResult {
    TestResult {
        status,
        metrics: TestMetrics {
            total_requests: 10,
            failed_requests: 2,
            avg_response_time: 100,
            p50_response_time: 90,
            p95_response_time: 150,
            max_response_time: 200,
            requests_per_second: 5.0,
        },
        thresholds: Vec::new(),
    }
}

fn sample_machine_summary_json() -> &'static str {
    r#"{
      "metrics": {
        "http_reqs": {
          "type": "counter",
          "contains": "default",
          "values": { "count": 12, "rate": 3.5 }
        },
        "http_req_duration": {
          "type": "trend",
          "contains": "time",
          "values": { "avg": 82, "med": 70, "p(95)": 110, "max": 120 }
        },
        "iterations": {
          "type": "counter",
          "contains": "default",
          "values": { "count": 12, "rate": 3.5 }
        },
        "data_received": {
          "type": "counter",
          "contains": "data",
          "values": { "count": 63000, "rate": 42000 }
        }
      }
    }"#
}

fn sample_v1_machine_summary_json() -> &'static str {
    r#"{
      "config": {
        "duration": 20
      },
      "results": {
        "checks": {
          "metrics": [],
          "results": []
        },
        "metrics": [
          {
            "name": "http_reqs",
            "type": "counter",
            "contains": "default",
            "values": { "count": 100 }
          },
          {
            "name": "http_req_failed",
            "type": "rate",
            "contains": "default",
            "values": { "matches": 10, "rate": 0.1, "total": 100 }
          },
          {
            "name": "http_req_duration",
            "type": "trend",
            "contains": "time",
            "values": {
              "avg": 150,
              "med": 120,
              "p95": 300,
              "max": 450
            }
          },
          {
            "name": "vus",
            "type": "gauge",
            "contains": "default",
            "values": { "value": 1 }
          }
        ]
      },
      "version": "1.0.0"
    }"#
}

fn basic_load_shape_override_test_script() -> &'static str {
    r#"import { sleep } from "k6";

function numberEnv(name, fallback) {
  const value = __ENV[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJsonEnv(name, fallback) {
  const value = __ENV[name];
  if (!value || !value.trim()) {
    return fallback;
  }

  return JSON.parse(value);
}

function mergeOptions(baseOptions, advancedOptions) {
  if (!advancedOptions || typeof advancedOptions !== "object" || Array.isArray(advancedOptions)) {
    return baseOptions;
  }

  return { ...baseOptions, ...advancedOptions };
}

function buildBasicOptions() {
  const thresholds = {};
  if ((__ENV.LOADRIFT_SKIP_BASIC_LOAD_SHAPE || "").toLowerCase() === "true") {
    return { thresholds };
  }

  return {
    vus: numberEnv("K6_VUS", 1),
    duration: __ENV.K6_DURATION || "1s",
    thresholds,
  };
}

export const options = mergeOptions(
  buildBasicOptions(),
  parseJsonEnv("LOADRIFT_ADVANCED_OPTIONS_JSON", null),
);

export default function () {
  sleep(0.01);
}
"#
}

#[test]
fn threshold_exit_requires_the_dedicated_k6_exit_code() {
    assert!(summary::is_threshold_failure_exit(
        Some(99),
        &sample_result(TestResultStatus::Failed)
    ));
    assert!(!summary::is_threshold_failure_exit(
        Some(1),
        &sample_result(TestResultStatus::Failed)
    ));
    assert!(!summary::is_threshold_failure_exit(
        Some(99),
        &sample_result(TestResultStatus::Passed)
    ));
}

#[test]
fn completion_status_reports_success_threshold_failure_and_execution_error() {
    let passed_result = sample_result(TestResultStatus::Passed);
    let failed_result = sample_result(TestResultStatus::Failed);

    let completed = process::completion_status(true, Some(0), &passed_result);
    assert!(matches!(completed.run_state, TestStatus::Completed));
    assert_eq!(completed.finish_reason, "completed");
    assert!(!completed.threshold_failure_exit);

    let threshold_failed = process::completion_status(false, Some(99), &failed_result);
    assert!(matches!(threshold_failed.run_state, TestStatus::Completed));
    assert_eq!(threshold_failed.finish_reason, "thresholds_failed");
    assert!(threshold_failed.threshold_failure_exit);

    let execution_error = process::completion_status(false, Some(1), &failed_result);
    assert!(matches!(execution_error.run_state, TestStatus::Failed));
    assert_eq!(execution_error.finish_reason, "execution_error");
    assert!(!execution_error.threshold_failure_exit);
}

#[test]
fn store_completion_persists_result_and_clears_running_state() {
    let state = Arc::new(Mutex::new(AppState {
        launch_in_progress: true,
        active_test: Some(test_running_test()),
        latest_metrics: Some(LiveMetrics {
            active_vus: 3,
            ..LiveMetrics::default()
        }),
        ..AppState::default()
    }));
    let result = sample_result(TestResultStatus::Warning);
    let metrics = LiveMetrics {
        active_vus: 9,
        total_requests: 10,
        failed_requests: 2,
        error_rate: 0.2,
        avg_response_time: 100,
        p50_response_time: 90,
        p95_response_time: 150,
        max_response_time: 200,
        requests_per_second: 5.0,
    };

    process::store_completion(
        &state,
        &metrics,
        &result,
        TestStatus::Completed,
        "thresholds_failed",
        Some("{\"metrics\":{}}".to_string()),
    );

    let app_state = state.lock().expect("state should remain readable");
    assert!(app_state.active_test.is_none());
    assert!(!app_state.launch_in_progress);
    assert!(matches!(app_state.test_status, TestStatus::Completed));
    assert_eq!(
        app_state.latest_finish_reason.as_deref(),
        Some("thresholds_failed")
    );
    assert!(app_state.latest_error_message.is_none());
    assert_eq!(
        app_state
            .latest_metrics
            .as_ref()
            .map(|value| value.active_vus),
        Some(0)
    );
    assert_eq!(
        app_state.latest_summary_json.as_deref(),
        Some("{\"metrics\":{}}")
    );
    assert!(matches!(
        app_state.latest_result.as_ref().map(|value| &value.status),
        Some(TestResultStatus::Warning)
    ));
}

#[test]
fn mark_stopped_sets_stopped_state_and_clears_error() {
    let state = Arc::new(Mutex::new(AppState {
        launch_in_progress: true,
        active_test: Some(test_running_test()),
        latest_metrics: Some(LiveMetrics {
            active_vus: 4,
            ..LiveMetrics::default()
        }),
        latest_error_message: Some("old error".to_string()),
        ..AppState::default()
    }));

    process::mark_stopped(&state);

    let app_state = state.lock().expect("state should remain readable");
    assert!(app_state.active_test.is_none());
    assert!(!app_state.launch_in_progress);
    assert!(matches!(app_state.test_status, TestStatus::Stopped));
    assert_eq!(app_state.latest_finish_reason.as_deref(), Some("stopped"));
    assert!(app_state.latest_error_message.is_none());
    assert_eq!(
        app_state
            .latest_metrics
            .as_ref()
            .map(|value| value.active_vus),
        Some(0)
    );
}

#[test]
fn parse_summary_supports_legacy_summary_export_shape() {
    let summary_json = r#"{
      "metrics": {
        "http_reqs": { "count": 2347, "rate": 7.82 },
        "http_req_failed": {
          "passes": 0,
          "fails": 2347,
          "value": 0,
          "thresholds": { "rate<0.05": false }
        },
        "http_req_duration": {
          "avg": 182.4,
          "med": 171.2,
          "p(95)": 412.7,
          "max": 921.3,
          "thresholds": { "p(95)<2000": false }
        }
      }
    }"#;

    let (result, metrics) =
        summary::parse_summary(summary_json, 10).expect("legacy summary export should parse");

    assert_eq!(result.metrics.total_requests, 2347);
    assert_eq!(result.metrics.failed_requests, 0);
    assert_eq!(result.metrics.avg_response_time, 182);
    assert_eq!(result.metrics.p50_response_time, 171);
    assert_eq!(result.metrics.p95_response_time, 413);
    assert_eq!(result.metrics.max_response_time, 921);
    assert_eq!(metrics.total_requests, 2347);
    assert_eq!(metrics.failed_requests, 0);
    assert_eq!(result.thresholds.len(), 2);
    assert!(result.thresholds.iter().all(|threshold| threshold.passed));
    assert!(matches!(result.status, TestResultStatus::Passed));
}

#[test]
fn parse_summary_supports_machine_readable_summary_shape() {
    let summary_json = r#"{
      "metrics": {
        "http_reqs": {
          "type": "counter",
          "contains": "default",
          "values": { "count": 100, "rate": 5 }
        },
        "http_req_failed": {
          "type": "rate",
          "contains": "default",
          "values": { "rate": 0.1 },
          "thresholds": { "rate<0.05": { "ok": false } }
        },
        "http_req_duration": {
          "type": "trend",
          "contains": "time",
          "values": {
            "avg": 150,
            "med": 120,
            "p(95)": 300,
            "max": 450
          },
          "thresholds": { "p(95)<200": { "ok": false } }
        }
      }
    }"#;

    let (result, metrics) =
        summary::parse_summary(summary_json, 10).expect("machine-readable summary should parse");

    assert_eq!(result.metrics.total_requests, 100);
    assert_eq!(result.metrics.failed_requests, 10);
    assert_eq!(metrics.error_rate, 0.1);
    assert_eq!(result.thresholds.len(), 2);
    assert!(result.thresholds.iter().all(|threshold| !threshold.passed));
    assert!(matches!(result.status, TestResultStatus::Failed));
}

#[test]
fn parse_summary_supports_v1_machine_summary_schema() {
    let (result, metrics) = summary::parse_summary(sample_v1_machine_summary_json(), 10)
        .expect("v1 machine summary should parse");

    assert_eq!(result.metrics.total_requests, 100);
    assert_eq!(result.metrics.failed_requests, 10);
    assert_eq!(result.metrics.avg_response_time, 150);
    assert_eq!(result.metrics.p50_response_time, 120);
    assert_eq!(result.metrics.p95_response_time, 300);
    assert_eq!(result.metrics.max_response_time, 450);
    assert_eq!(result.metrics.requests_per_second, 5.0);
    assert_eq!(metrics.total_requests, 100);
    assert_eq!(metrics.failed_requests, 10);
    assert_eq!(metrics.requests_per_second, 5.0);
    assert_eq!(metrics.error_rate, 0.1);
    assert!(result.thresholds.is_empty());
    assert!(matches!(result.status, TestResultStatus::Warning));
}

#[test]
fn parse_summary_supports_root_level_metrics_shape() {
    let summary_json = r#"{
      "http_reqs": {
        "type": "counter",
        "contains": "default",
        "values": { "count": 24, "rate": 4 }
      },
      "http_req_failed": {
        "type": "rate",
        "contains": "default",
        "values": { "rate": 0.25 }
      },
      "http_req_duration": {
        "type": "trend",
        "contains": "time",
        "values": {
          "avg": 190,
          "med": 150,
          "p(95)": 410,
          "max": 620
        }
      }
    }"#;

    let (result, metrics) =
        summary::parse_summary(summary_json, 10).expect("root-level metric maps should parse");

    assert_eq!(result.metrics.total_requests, 24);
    assert_eq!(result.metrics.failed_requests, 6);
    assert_eq!(result.metrics.avg_response_time, 190);
    assert_eq!(result.metrics.p95_response_time, 410);
    assert_eq!(metrics.requests_per_second, 4.0);
    assert!(matches!(result.status, TestResultStatus::Warning));
}

#[test]
fn fallback_result_from_live_metrics_preserves_exportable_totals() {
    let metrics = LiveMetrics {
        active_vus: 0,
        total_requests: 48,
        failed_requests: 3,
        error_rate: 0.0625,
        avg_response_time: 220,
        p50_response_time: 140,
        p95_response_time: 360,
        max_response_time: 890,
        requests_per_second: 6.2,
    };

    let result = summary::result_from_live_metrics(&metrics, None);

    assert_eq!(result.metrics.total_requests, 48);
    assert_eq!(result.metrics.failed_requests, 3);
    assert_eq!(result.metrics.avg_response_time, 220);
    assert_eq!(result.metrics.p50_response_time, 140);
    assert_eq!(result.metrics.p95_response_time, 360);
    assert_eq!(result.metrics.max_response_time, 890);
    assert_eq!(result.metrics.requests_per_second, 6.2);
    assert!(result.thresholds.is_empty());
    assert!(matches!(result.status, TestResultStatus::Warning));
}

#[test]
fn parse_summary_supports_nested_metrics_wrappers() {
    let summary_json = r#"{
      "data": {
        "summary": {
          "metrics": {
            "http_reqs": {
              "type": "counter",
              "contains": "default",
              "values": { "count": 42, "rate": 2.5 }
            },
            "http_req_failed": {
              "type": "rate",
              "contains": "default",
              "values": { "rate": 0.05 }
            },
            "http_req_duration": {
              "type": "trend",
              "contains": "time",
              "values": {
                "avg": 180,
                "med": 140,
                "p(95)": 360,
                "max": 420
              }
            }
          }
        }
      }
    }"#;

    let (result, metrics) =
        summary::parse_summary(summary_json, 10).expect("nested summary wrapper should parse");

    assert_eq!(result.metrics.total_requests, 42);
    assert_eq!(result.metrics.failed_requests, 2);
    assert_eq!(result.metrics.avg_response_time, 180);
    assert_eq!(result.metrics.p50_response_time, 140);
    assert_eq!(result.metrics.p95_response_time, 360);
    assert_eq!(result.metrics.max_response_time, 420);
    assert_eq!(metrics.total_requests, 42);
    assert_eq!(metrics.failed_requests, 2);
}

#[test]
fn analyze_advanced_options_detects_when_basic_load_shape_must_be_skipped() {
    let config = process::analyze_advanced_options_json(Some(
        r#"{"scenarios":{"steady":{"executor":"shared-iterations","vus":1,"iterations":1}}}"#,
    ))
    .expect("advanced options should parse");
    assert!(config.overrides_basic_load_shape);

    let config = process::analyze_advanced_options_json(Some(
        r#"{"stages":[{"duration":"10s","target":10}]}"#,
    ))
    .expect("advanced stage options should parse");
    assert!(config.overrides_basic_load_shape);

    let config = process::analyze_advanced_options_json(Some(r#"{"tags":{"suite":"api"}}"#))
        .expect("simple advanced options should parse");
    assert!(!config.overrides_basic_load_shape);
}

#[test]
fn parse_summary_matches_real_bundled_k6_summary_export() {
    let Some(k6_binary) = bundled_k6_binary() else {
        return;
    };

    let script = r#"import http from "k6/http";

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  http.get("http://127.0.0.1:1");
}
"#;

    let script_path =
        process::write_temp_file("js", script).expect("fixture script should be written");
    let summary_path = process::temp_file_path("json");

    let output = Command::new(&k6_binary)
        .arg("run")
        .arg("--summary-export")
        .arg(&summary_path)
        .arg(&script_path)
        .env("K6_NO_COLOR", "true")
        .env("K6_WEB_DASHBOARD", "false")
        .output()
        .expect("bundled k6 should run");

    let _ = fs::remove_file(&script_path);
    let summary_json =
        fs::read_to_string(&summary_path).expect("bundled k6 should write the summary file");
    let _ = fs::remove_file(&summary_path);

    assert!(
        output.status.success(),
        "bundled k6 execution failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let summary: Value =
        serde_json::from_str(&summary_json).expect("bundled k6 summary should be valid JSON");
    let metrics = summary
        .get("metrics")
        .and_then(Value::as_object)
        .expect("summary should contain a metrics object");
    let http_reqs = metrics
        .get("http_reqs")
        .and_then(Value::as_object)
        .expect("summary should contain an http_reqs metric");
    let http_req_failed = metrics
        .get("http_req_failed")
        .and_then(Value::as_object)
        .expect("summary should contain an http_req_failed metric");

    assert_eq!(
        http_reqs.get("count").and_then(Value::as_u64),
        Some(1),
        "bundled k6 v1.6.1 should export legacy flat counter fields",
    );
    assert!(
        !http_reqs.contains_key("values"),
        "bundled k6 summary export unexpectedly switched schema; update parse_summary coverage"
    );
    assert_eq!(
        http_req_failed.get("value").and_then(Value::as_f64),
        Some(1.0)
    );

    let (result, metrics) =
        summary::parse_summary(&summary_json, 1).expect("real bundled k6 summary should parse");

    assert_eq!(result.metrics.total_requests, 1);
    assert_eq!(result.metrics.failed_requests, 1);
    assert_eq!(metrics.total_requests, 1);
    assert_eq!(metrics.failed_requests, 1);
    assert!(matches!(result.status, TestResultStatus::Warning));
}

#[test]
fn live_metrics_aggregator_tracks_vus_and_request_totals() {
    let mut aggregator = process::LiveMetricsAggregator::default();

    assert!(aggregator.apply_line(r#"{"type":"Point","metric":"vus","data":{"value":4}}"#));
    assert!(aggregator.apply_line(r#"{"type":"Point","metric":"http_reqs","data":{"value":1}}"#));
    assert!(
        aggregator.apply_line(r#"{"type":"Point","metric":"http_req_failed","data":{"value":1}}"#)
    );
    assert!(aggregator
        .apply_line(r#"{"type":"Point","metric":"http_req_duration","data":{"value":120}}"#));
    assert!(aggregator
        .apply_line(r#"{"type":"Point","metric":"http_req_duration","data":{"value":500}}"#));
    assert!(aggregator
        .apply_line(r#"{"type":"Point","metric":"http_req_duration","data":{"value":280}}"#));

    let snapshot = aggregator.snapshot();
    assert_eq!(snapshot.active_vus, 4);
    assert_eq!(snapshot.total_requests, 1);
    assert_eq!(snapshot.failed_requests, 1);
    assert_eq!(snapshot.error_rate, 1.0);
    assert_eq!(snapshot.avg_response_time, 300);
    assert_eq!(snapshot.p50_response_time, 280);
    assert_eq!(snapshot.p95_response_time, 500);
    assert_eq!(snapshot.max_response_time, 500);
}

#[test]
fn live_metrics_aggregator_clamps_outlier_durations_to_configured_histogram_range() {
    let mut aggregator = process::LiveMetricsAggregator::default();

    assert!(aggregator
        .apply_line(r#"{"type":"Point","metric":"http_req_duration","data":{"value":172800000}}"#));

    let snapshot = aggregator.snapshot();
    assert_eq!(snapshot.avg_response_time, 86_400_000);
    assert_eq!(snapshot.p95_response_time, 86_400_000);
    assert_eq!(snapshot.max_response_time, 86_400_000);
}

#[test]
fn extract_end_of_test_summary_prefers_k6_summary_section() {
    let output = "banner\nsetup\n\n  █ THRESHOLDS \n\n    http_req_duration\n    ✓ 'p(95)<200'\n\n  █ TOTAL RESULTS \n\n    http_reqs: 12\n";

    let extracted = report::extract_end_of_test_summary(output);

    assert!(extracted.starts_with("█ THRESHOLDS"));
    assert!(extracted.contains("█ TOTAL RESULTS"));
    assert!(!extracted.contains("banner"));
}

#[test]
fn extract_end_of_test_summary_falls_back_to_trimmed_output() {
    let output = "plain output only\n";

    assert_eq!(
        report::extract_end_of_test_summary(output),
        "plain output only"
    );
}

#[test]
fn render_report_preserves_full_console_summary_sections() {
    let result = summary_report_result();

    let output = "banner\n\n  █ THRESHOLDS \n\n    http_req_duration\n    ✓ 'p(95)<200'\n\n  █ TOTAL RESULTS \n\n    HTTP\n    http_reqs......................: 12     3.50/s\n\n    EXECUTION\n    iterations.....................: 12     3.50/s\n\n    NETWORK\n    data_received..................: 63 kB 42 kB/s\n";
    let rendered = report::render_report(&result, output, Some(sample_machine_summary_json()));

    assert!(rendered.contains("█ THRESHOLDS"));
    assert!(rendered.contains("http_reqs......................: 12     3.50/s"));
    assert!(rendered.contains("EXECUTION"));
    assert!(rendered.contains("NETWORK"));
    assert!(rendered.contains("Raw k6 summary JSON"));
    assert!(rendered.contains("Type: counter"));
    assert!(!rendered.contains("banner"));
}

#[test]
fn render_report_reads_nested_metrics_wrappers() {
    let result = summary_report_result();
    let summary_json = r#"{
      "exported": {
        "metrics": {
          "http_reqs": {
            "type": "counter",
            "contains": "default",
            "values": { "count": 12, "rate": 3.5 }
          }
        }
      }
    }"#;

    let rendered = report::render_report(&result, "plain output", Some(summary_json));

    assert!(rendered.contains("Type: counter"));
    assert!(rendered.contains("count"));
}

#[test]
fn render_report_supports_v1_machine_summary_schema() {
    let result = summary_report_result();

    let rendered = report::render_report(
        &result,
        "header\n█ TOTAL RESULTS\nhttp_req_duration.............: avg=82 min=70 med=70 max=120 p(95)=110",
        Some(sample_v1_machine_summary_json()),
    );

    assert!(rendered.contains("HTTP"));
    assert!(rendered.contains("http_req_duration"));
    assert!(rendered.contains("p(95)"));
    assert!(rendered.contains("300"));
}

#[test]
fn render_report_falls_back_to_trimmed_output_when_summary_markers_are_missing() {
    let result = summary_report_result();

    let report = report::render_report(&result, "plain output", None);

    assert!(report.contains("plain output"));
}

#[test]
fn bundled_k6_accepts_advanced_scenarios_when_basic_load_shape_is_suppressed() {
    let Some(k6_binary) = bundled_k6_binary() else {
        return;
    };

    let script_path = process::write_temp_file("js", basic_load_shape_override_test_script())
        .expect("fixture script should be written");

    let output = Command::new(&k6_binary)
        .arg("run")
        .arg(&script_path)
        .env("K6_NO_COLOR", "true")
        .env("K6_WEB_DASHBOARD", "false")
        .env("LOADRIFT_SKIP_BASIC_LOAD_SHAPE", "true")
        .env(
            "LOADRIFT_ADVANCED_OPTIONS_JSON",
            r#"{"scenarios":{"steady":{"executor":"shared-iterations","vus":1,"iterations":1}}}"#,
        )
        .output()
        .expect("bundled k6 should run");

    let _ = fs::remove_file(&script_path);

    assert!(
        output.status.success(),
        "bundled k6 execution failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn bundled_k6_accepts_advanced_iterations_when_basic_load_shape_is_suppressed() {
    let Some(k6_binary) = bundled_k6_binary() else {
        return;
    };

    let script_path = process::write_temp_file("js", basic_load_shape_override_test_script())
        .expect("fixture script should be written");

    let output = Command::new(&k6_binary)
        .arg("run")
        .arg(&script_path)
        .env("K6_NO_COLOR", "true")
        .env("K6_WEB_DASHBOARD", "false")
        .env("LOADRIFT_SKIP_BASIC_LOAD_SHAPE", "true")
        .env("LOADRIFT_ADVANCED_OPTIONS_JSON", r#"{"iterations":1}"#)
        .output()
        .expect("bundled k6 should run");

    let _ = fs::remove_file(&script_path);

    assert!(
        output.status.success(),
        "bundled k6 execution failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn bundled_k6_binary() -> Option<PathBuf> {
    let k6_binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join(k6_binary_name());
    if !k6_binary.is_file() {
        eprintln!(
            "Skipping bundled k6 summary test because {} is missing.",
            k6_binary.display()
        );
        return None;
    }

    Some(k6_binary)
}

fn test_running_test() -> RunningTest {
    let child = Command::new("sh")
        .arg("-c")
        .arg("sleep 0.1")
        .spawn()
        .expect("test child should spawn");

    RunningTest {
        child: Arc::new(Mutex::new(child)),
        stop_requested: Arc::new(AtomicBool::new(false)),
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn k6_binary_name() -> &'static str {
    "k6-x86_64-unknown-linux-gnu"
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn k6_binary_name() -> &'static str {
    "k6-aarch64-unknown-linux-gnu"
}

#[cfg(not(any(
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "aarch64")
)))]
fn k6_binary_name() -> &'static str {
    "k6"
}
