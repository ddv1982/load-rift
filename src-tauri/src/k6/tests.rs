use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::{process, report, summary};
use crate::models::{
    LiveMetrics, TestMetrics, TestResult, TestResultSource, TestResultStatus, TestStatus,
};
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
        "run-1",
        process::CompletionRecord {
            metrics: metrics.clone(),
            result: result.clone(),
            run_state: TestStatus::Completed,
            finish_reason: "thresholds_failed".to_string(),
            summary_json: Some("{\"metrics\":{}}".to_string()),
            result_source: TestResultSource::Summary,
            summary_issue: None,
            error_message: None,
        },
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
        app_state.latest_result_source,
        Some(TestResultSource::Summary)
    );
    assert!(app_state.latest_summary_issue.is_none());
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

    process::mark_stopped(&state, "run-1");
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
fn stale_completion_does_not_overwrite_newer_active_run_state() {
    let state = Arc::new(Mutex::new(AppState {
        launch_in_progress: false,
        active_test: Some(test_running_test_with_id("new-run")),
        latest_run_id: Some("new-run".to_string()),
        latest_metrics: Some(LiveMetrics {
            active_vus: 3,
            ..LiveMetrics::default()
        }),
        test_status: TestStatus::Running,
        ..AppState::default()
    }));
    let result = sample_result(TestResultStatus::Warning);
    let stale_metrics = LiveMetrics {
        total_requests: 99,
        ..LiveMetrics::default()
    };

    let stored = process::store_completion(
        &state,
        "old-run",
        process::CompletionRecord {
            metrics: stale_metrics,
            result,
            run_state: TestStatus::Completed,
            finish_reason: "completed".to_string(),
            summary_json: Some("{\"stale\":true}".to_string()),
            result_source: TestResultSource::Summary,
            summary_issue: None,
            error_message: None,
        },
    );

    let app_state = state.lock().expect("state should remain readable");
    assert!(!stored);
    assert!(app_state.active_test.is_some());
    assert!(matches!(app_state.test_status, TestStatus::Running));
    assert_eq!(app_state.latest_run_id.as_deref(), Some("new-run"));
    assert_eq!(
        app_state
            .latest_metrics
            .as_ref()
            .map(|value| value.total_requests),
        Some(0)
    );
    assert!(app_state.latest_result.is_none());
    assert!(app_state.latest_summary_json.is_none());
}

#[test]
fn stale_stop_does_not_clear_newer_active_run_state() {
    let state = Arc::new(Mutex::new(AppState {
        launch_in_progress: false,
        active_test: Some(test_running_test_with_id("new-run")),
        latest_run_id: Some("new-run".to_string()),
        latest_metrics: Some(LiveMetrics {
            active_vus: 3,
            ..LiveMetrics::default()
        }),
        test_status: TestStatus::Running,
        ..AppState::default()
    }));

    let stopped = process::mark_stopped(&state, "old-run");

    let app_state = state.lock().expect("state should remain readable");
    assert!(!stopped);
    assert!(app_state.active_test.is_some());
    assert!(matches!(app_state.test_status, TestStatus::Running));
    assert_eq!(app_state.latest_finish_reason, None);
    assert_eq!(
        app_state
            .latest_metrics
            .as_ref()
            .map(|value| value.active_vus),
        Some(3)
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
fn parse_summary_reads_threshold_targets_after_comparison_operators() {
    let summary_json = r#"{
      "metrics": {
        "http_req_duration": {
          "type": "trend",
          "contains": "time",
          "values": { "avg": 150, "p(95)": 300, "value": 150 },
          "thresholds": {
            "p(95)<2000": { "ok": true },
            "value>=12.5": { "ok": true }
          }
        },
        "http_req_failed": {
          "type": "rate",
          "contains": "default",
          "values": { "rate": 0.005 },
          "thresholds": { "rate<0.01": { "ok": true } }
        }
      }
    }"#;

    let (result, _) =
        summary::parse_summary(summary_json, 1).expect("threshold summary should parse");

    let p95 = result
        .thresholds
        .iter()
        .find(|threshold| threshold.name.contains("p(95)<2000"))
        .expect("p95 threshold should be collected");
    assert_eq!(p95.threshold, 2000.0);
    assert_eq!(p95.actual, 300.0);

    let rate = result
        .thresholds
        .iter()
        .find(|threshold| threshold.name.contains("rate<0.01"))
        .expect("rate threshold should be collected");
    assert_eq!(rate.threshold, 0.01);
    assert_eq!(rate.actual, 0.005);

    let value = result
        .thresholds
        .iter()
        .find(|threshold| threshold.name.contains("value>=12.5"))
        .expect("value threshold should be collected");
    assert_eq!(value.threshold, 12.5);
    assert_eq!(value.actual, 150.0);
}

#[test]
fn private_run_temp_artifacts_live_in_private_directory_and_clean_up_on_drop() {
    let artifacts = process::create_run_temp_artifacts("export default function () {}")
        .expect("private temp artifacts should be created");
    let temp_dir = artifacts
        .script_path
        .parent()
        .expect("script should be inside a temp dir")
        .to_path_buf();

    assert!(temp_dir.is_dir());
    assert!(artifacts.script_path.is_file());
    assert_eq!(
        fs::read_to_string(&artifacts.script_path).expect("script should be readable"),
        "export default function () {}"
    );
    assert_eq!(artifacts.summary_path.parent(), Some(temp_dir.as_path()));
    assert_eq!(artifacts.metrics_path.parent(), Some(temp_dir.as_path()));

    drop(artifacts);
    assert!(
        !temp_dir.exists(),
        "temp dir should be removed when artifacts drop"
    );
}

#[test]
fn explicit_run_temp_artifact_cleanup_removes_directory() {
    let artifacts = process::create_run_temp_artifacts("export default function () {}")
        .expect("private temp artifacts should be created");
    let temp_dir = artifacts.dir_path().to_path_buf();

    let outcome = artifacts.cleanup(process::ArtifactRetentionPolicy::Delete);

    assert!(matches!(
        outcome.action,
        process::ArtifactCleanupAction::Removed
    ));
    assert!(
        !temp_dir.exists(),
        "explicit cleanup should remove temp dir"
    );
}

#[test]
fn debug_preserve_mode_keeps_artifact_directory() {
    let artifacts = process::create_run_temp_artifacts("export default function () {}")
        .expect("private temp artifacts should be created");
    let temp_dir = artifacts.dir_path().to_path_buf();

    let outcome = artifacts.cleanup(process::ArtifactRetentionPolicy::PreserveDebug);

    assert!(matches!(
        outcome.action,
        process::ArtifactCleanupAction::Preserved
    ));
    assert!(temp_dir.is_dir(), "preserve mode should keep temp dir");
    assert!(temp_dir.join("script.js").is_file());
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn artifact_marker_is_written_without_script_contents() {
    let script = "export default function secret_request_body_token() {}";
    let artifacts = process::create_run_temp_artifacts(script)
        .expect("private temp artifacts should be created");
    let marker_path = artifacts.dir_path().join(".loadrift-k6-artifacts.json");

    let marker = fs::read_to_string(marker_path).expect("marker should be readable");
    let marker: Value = serde_json::from_str(&marker).expect("marker should be JSON");

    assert_eq!(
        marker.get("owner").and_then(Value::as_str),
        Some("loadrift")
    );
    assert_eq!(
        marker.get("kind").and_then(Value::as_str),
        Some("k6-run-artifacts")
    );
    assert_eq!(
        marker.get("preserveDebug").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(marker.get("pid").and_then(Value::as_u64), Some(0));
    assert_eq!(
        marker.get("pidRole").and_then(Value::as_str),
        Some("pendingK6Child")
    );
    assert!(marker.get("createdAtUnixSeconds").is_some());
    assert!(!marker.to_string().contains("secret_request_body_token"));
    assert!(!marker.to_string().contains(script));
}

#[test]
fn artifact_marker_updates_to_spawned_k6_child_pid() {
    let artifacts = process::create_run_temp_artifacts("export default function () {}")
        .expect("private temp artifacts should be created");
    let marker_path = artifacts.dir_path().join(".loadrift-k6-artifacts.json");

    artifacts
        .mark_spawned_child(42_424, process::ArtifactRetentionPolicy::Delete)
        .expect("spawned child marker should update");

    let marker = fs::read_to_string(marker_path).expect("marker should be readable");
    let marker: Value = serde_json::from_str(&marker).expect("marker should be JSON");
    assert_eq!(marker.get("pid").and_then(Value::as_u64), Some(42_424));
    assert_eq!(
        marker.get("pidRole").and_then(Value::as_str),
        Some("k6Child")
    );
    assert_ne!(
        marker.get("pid").and_then(Value::as_u64),
        Some(std::process::id() as u64)
    );
}

#[test]
fn startup_cleanup_removes_stale_marker_owned_artifacts() {
    let root = tempfile::tempdir().expect("cleanup root should be created");
    let artifact_dir = root.path().join("loadrift-stale-marker");
    fs::create_dir(&artifact_dir).expect("artifact dir should be created");
    fs::write(artifact_dir.join("script.js"), "secret script")
        .expect("artifact file should be written");
    write_artifact_marker(&artifact_dir, 1, false);

    let report = process::cleanup_stale_k6_temp_artifacts_in(
        root.path(),
        SystemTime::now() + Duration::from_secs(8 * 24 * 60 * 60),
    );

    assert_eq!(report.scanned, 1);
    assert_eq!(report.removed, 1);
    assert!(!artifact_dir.exists());
}

#[test]
fn startup_cleanup_skips_old_marker_dirs_with_fresh_artifact_activity() {
    let root = tempfile::tempdir().expect("cleanup root should be created");
    let artifact_dir = root.path().join("loadrift-active-marker");
    fs::create_dir(&artifact_dir).expect("artifact dir should be created");
    fs::write(artifact_dir.join("script.js"), "secret script").expect("script should be written");
    fs::write(artifact_dir.join("metrics.json"), "{}").expect("metrics should be written");
    write_artifact_marker(&artifact_dir, 1, false);

    let report = process::cleanup_stale_k6_temp_artifacts_in(root.path(), SystemTime::now());

    assert_eq!(report.scanned, 1);
    assert_eq!(report.removed, 0);
    assert_eq!(report.skipped_fresh, 1);
    assert!(artifact_dir.is_dir());
}

#[test]
fn startup_cleanup_skips_provisional_parent_pid_markers_as_unsafe() {
    let root = tempfile::tempdir().expect("cleanup root should be created");
    let artifact_dir = root.path().join("loadrift-provisional-marker");
    fs::create_dir(&artifact_dir).expect("artifact dir should be created");
    fs::write(artifact_dir.join("script.js"), "secret script")
        .expect("artifact file should be written");
    let marker = serde_json::json!({
        "owner": "loadrift",
        "kind": "k6-run-artifacts",
        "schemaVersion": 1,
        "createdAtUnixSeconds": 1,
        "pid": std::process::id(),
        "pidRole": "pendingK6Child",
        "preserveDebug": false,
    });
    fs::write(
        artifact_dir.join(".loadrift-k6-artifacts.json"),
        serde_json::to_string(&marker).expect("marker should serialize"),
    )
    .expect("marker should be written");

    let report = process::cleanup_stale_k6_temp_artifacts_in(
        root.path(),
        SystemTime::now() + Duration::from_secs(8 * 24 * 60 * 60),
    );

    assert_eq!(report.scanned, 1);
    assert_eq!(report.removed, 0);
    assert_eq!(report.skipped_unsafe, 1);
    assert!(artifact_dir.is_dir());
}

#[test]
fn startup_cleanup_skips_bad_schema_and_unexpected_shapes() {
    let root = tempfile::tempdir().expect("cleanup root should be created");
    let bad_schema_dir = root.path().join("loadrift-bad-schema");
    let missing_script_dir = root.path().join("loadrift-missing-script");
    let unknown_file_dir = root.path().join("loadrift-unknown-file");
    for dir in [&bad_schema_dir, &missing_script_dir, &unknown_file_dir] {
        fs::create_dir(dir).expect("artifact dir should be created");
    }
    fs::write(bad_schema_dir.join("script.js"), "secret script").expect("script should be written");
    write_artifact_marker_with_schema(&bad_schema_dir, 1, false, dead_test_pid(), 2);
    write_artifact_marker(&missing_script_dir, 1, false);
    fs::write(unknown_file_dir.join("script.js"), "secret script")
        .expect("script should be written");
    fs::write(unknown_file_dir.join("notes.txt"), "do not delete")
        .expect("unknown file should be written");
    write_artifact_marker(&unknown_file_dir, 1, false);

    let report = process::cleanup_stale_k6_temp_artifacts_in(
        root.path(),
        SystemTime::now() + Duration::from_secs(8 * 24 * 60 * 60),
    );

    assert_eq!(report.scanned, 3);
    assert_eq!(report.removed, 0);
    assert_eq!(report.skipped_unsafe, 3);
    assert!(bad_schema_dir.is_dir());
    assert!(missing_script_dir.is_dir());
    assert!(unknown_file_dir.is_dir());
}

#[cfg(unix)]
#[test]
fn startup_cleanup_skips_symlink_artifact_children() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().expect("cleanup root should be created");
    let artifact_dir = root.path().join("loadrift-symlink-child");
    let target = root.path().join("outside-secret.txt");
    fs::create_dir(&artifact_dir).expect("artifact dir should be created");
    fs::write(&target, "do not delete").expect("target should be written");
    symlink(&target, artifact_dir.join("script.js")).expect("symlink should be created");
    write_artifact_marker(&artifact_dir, 1, false);

    let report = process::cleanup_stale_k6_temp_artifacts_in(
        root.path(),
        SystemTime::now() + Duration::from_secs(8 * 24 * 60 * 60),
    );

    assert_eq!(report.scanned, 1);
    assert_eq!(report.removed, 0);
    assert_eq!(report.skipped_unsafe, 1);
    assert!(artifact_dir.is_dir());
    assert!(target.is_file());
}

#[test]
fn startup_cleanup_skips_stale_marker_when_pid_is_alive() {
    let root = tempfile::tempdir().expect("cleanup root should be created");
    let artifact_dir = root.path().join("loadrift-live-pid-marker");
    fs::create_dir(&artifact_dir).expect("artifact dir should be created");
    fs::write(artifact_dir.join("script.js"), "secret script")
        .expect("artifact file should be written");
    write_artifact_marker_with_pid(&artifact_dir, 1, false, std::process::id());

    let report = process::cleanup_stale_k6_temp_artifacts_in(
        root.path(),
        SystemTime::now() + Duration::from_secs(8 * 24 * 60 * 60),
    );

    assert_eq!(report.scanned, 1);
    assert_eq!(report.removed, 0);
    assert_eq!(report.skipped_fresh, 1);
    assert!(artifact_dir.is_dir());
}

#[test]
fn startup_cleanup_preserves_fresh_and_debug_preserved_marker_dirs() {
    let root = tempfile::tempdir().expect("cleanup root should be created");
    let fresh_dir = root.path().join("loadrift-fresh-marker");
    let preserved_dir = root.path().join("loadrift-preserved-marker");
    fs::create_dir(&fresh_dir).expect("fresh dir should be created");
    fs::create_dir(&preserved_dir).expect("preserved dir should be created");
    write_artifact_marker(&fresh_dir, 10 * 24 * 60 * 60, false);
    write_artifact_marker(&preserved_dir, 1, true);

    let report = process::cleanup_stale_k6_temp_artifacts_in(
        root.path(),
        UNIX_EPOCH + Duration::from_secs(10 * 24 * 60 * 60),
    );

    assert_eq!(report.scanned, 2);
    assert_eq!(report.removed, 0);
    assert_eq!(report.skipped_fresh, 1);
    assert_eq!(report.skipped_preserved, 1);
    assert!(fresh_dir.is_dir());
    assert!(preserved_dir.is_dir());
}

#[test]
fn startup_cleanup_skips_markerless_legacy_artifact_dirs() {
    let root = tempfile::tempdir().expect("cleanup root should be created");
    let legacy_dir = root.path().join("loadrift-legacy");
    let unsafe_dir = root.path().join("loadrift-unknown");
    fs::create_dir(&legacy_dir).expect("legacy dir should be created");
    fs::create_dir(&unsafe_dir).expect("unsafe dir should be created");
    fs::write(legacy_dir.join("script.js"), "secret script")
        .expect("legacy script should be written");
    fs::write(legacy_dir.join("summary.json"), "{}").expect("legacy summary should be written");
    fs::write(unsafe_dir.join("notes.txt"), "do not delete")
        .expect("unknown file should be written");

    let report = process::cleanup_stale_k6_temp_artifacts_in(
        root.path(),
        SystemTime::now() + Duration::from_secs(8 * 24 * 60 * 60),
    );

    assert_eq!(report.scanned, 2);
    assert_eq!(report.removed, 0);
    assert_eq!(report.skipped_unsafe, 2);
    assert!(legacy_dir.is_dir());
    assert!(unsafe_dir.is_dir());
}

#[cfg(unix)]
#[test]
fn private_run_temp_artifacts_remove_group_and_other_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let artifacts = process::create_run_temp_artifacts("export default function () {}")
        .expect("private temp artifacts should be created");
    let temp_dir = artifacts
        .script_path
        .parent()
        .expect("script should be inside a temp dir");

    let dir_mode = fs::metadata(temp_dir)
        .expect("temp dir metadata should be readable")
        .permissions()
        .mode()
        & 0o777;
    let script_mode = fs::metadata(&artifacts.script_path)
        .expect("script metadata should be readable")
        .permissions()
        .mode()
        & 0o777;

    assert_eq!(dir_mode & 0o077, 0);
    assert_eq!(script_mode & 0o077, 0);
}

#[test]
fn private_run_temp_artifacts_are_readable_by_bundled_k6() {
    let Some(k6_binary) = bundled_k6_binary() else {
        return;
    };

    let artifacts = process::create_run_temp_artifacts(
        r#"export const options = { vus: 1, iterations: 1 };
export default function () {}
"#,
    )
    .expect("private temp artifacts should be created");
    let temp_dir = artifacts
        .script_path
        .parent()
        .expect("script should be inside temp dir")
        .to_path_buf();

    assert!(artifacts.script_path.is_file());
    let output = Command::new(&k6_binary)
        .arg("run")
        .arg("--summary-export")
        .arg(&artifacts.summary_path)
        .arg("--out")
        .arg(format!("json={}", artifacts.metrics_path.display()))
        .arg(&artifacts.script_path)
        .env("K6_NO_COLOR", "true")
        .env("K6_WEB_DASHBOARD", "false")
        .output()
        .expect("bundled k6 should run against private temp artifacts");

    assert!(
        output.status.success(),
        "bundled k6 could not read private temp script\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        artifacts.summary_path.is_file(),
        "bundled k6 should write summary inside private temp directory"
    );
    assert!(
        artifacts.metrics_path.is_file(),
        "bundled k6 should write live metrics inside private temp directory"
    );

    drop(artifacts);
    assert!(
        !temp_dir.exists(),
        "private temp dir should clean up after drop"
    );
}

#[test]
fn dropped_private_run_temp_artifacts_reproduce_missing_script_class() {
    let Some(k6_binary) = bundled_k6_binary() else {
        return;
    };

    let artifacts = process::create_run_temp_artifacts("export default function () {}")
        .expect("private temp artifacts should be created");
    let script_path = artifacts.script_path.clone();
    let summary_path = artifacts.summary_path.clone();
    assert!(script_path.is_file());
    drop(artifacts);
    assert!(!script_path.exists());

    let output = Command::new(&k6_binary)
        .arg("run")
        .arg("--summary-export")
        .arg(&summary_path)
        .arg(&script_path)
        .env("K6_NO_COLOR", "true")
        .env("K6_WEB_DASHBOARD", "false")
        .output()
        .expect("bundled k6 should run and report the missing entry script");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("script.js")
            && (stderr.contains("couldn't be found")
                || stderr.contains("no such file")
                || stderr.contains("cannot find")
                || stderr.contains("not found")),
        "stderr should identify the missing entry script, got:\n{stderr}"
    );
    assert!(
        !summary_path.exists(),
        "k6 should not create a summary when the entry script cannot be loaded"
    );
}

#[test]
fn primary_error_prefers_bounded_stderr_tail_over_generic_exit_status() {
    let stderr = "time=error msg=\"The moduleSpecifier \\\"/tmp/loadrift-x/script.js\\\" couldn't be found on local disk.\"";

    assert_eq!(process::primary_error_from_stderr(stderr, Some(1)), stderr);
    assert_eq!(
        process::primary_error_from_stderr("", Some(17)),
        "k6 exited with status code 17."
    );
}

#[test]
fn completion_record_preserves_primary_error_for_fallback_result() {
    let state = Arc::new(Mutex::new(AppState {
        launch_in_progress: true,
        active_test: Some(test_running_test()),
        latest_metrics: Some(LiveMetrics::default()),
        ..AppState::default()
    }));
    let primary_error =
        "The moduleSpecifier \"/tmp/loadrift-x/script.js\" couldn't be found on local disk.";
    let summary_issue =
        "k6 finished without a readable summary file at /tmp/loadrift-x/summary.json";

    let stored = process::store_completion(
        &state,
        "run-1",
        process::CompletionRecord {
            metrics: LiveMetrics::default(),
            result: sample_result(TestResultStatus::Warning),
            run_state: TestStatus::Failed,
            finish_reason: "execution_error".to_string(),
            summary_json: None,
            result_source: TestResultSource::LiveMetricsFallback,
            summary_issue: Some(summary_issue.to_string()),
            error_message: Some(primary_error.to_string()),
        },
    );

    assert!(stored);
    let app_state = state.lock().expect("state should remain readable");
    assert!(app_state.active_test.is_none());
    assert!(matches!(app_state.test_status, TestStatus::Failed));
    assert_eq!(
        app_state.latest_error_message.as_deref(),
        Some(primary_error)
    );
    assert_eq!(
        app_state.latest_result_source,
        Some(TestResultSource::LiveMetricsFallback)
    );
    assert_eq!(
        app_state.latest_summary_issue.as_deref(),
        Some(summary_issue)
    );
}

#[test]
fn artifact_diagnostics_include_metadata_without_script_contents() {
    let script = "export default function secret_request_body_token() {}";
    let artifacts = process::create_run_temp_artifacts(script)
        .expect("private temp artifacts should be created");

    let diagnostics = process::temp_artifact_diagnostics_output_for_test(&artifacts);

    assert!(diagnostics.contains("script="));
    assert!(diagnostics.contains("summary="));
    assert!(diagnostics.contains("metrics="));
    assert!(diagnostics.contains("exists=true"));
    assert!(diagnostics.contains("len="));
    assert!(diagnostics.contains("metadataError=none"));
    assert!(!diagnostics.contains("secret_request_body_token"));
    assert!(!diagnostics.contains(script));
}

#[test]
fn user_artifact_diagnostics_redact_paths_by_default() {
    let artifacts = process::create_run_temp_artifacts("export default function () {}")
        .expect("private temp artifacts should be created");

    let redacted = process::temp_artifact_diagnostics_user_output_for_test(&artifacts, false);
    let debug = process::temp_artifact_diagnostics_user_output_for_test(&artifacts, true);

    assert!(redacted.contains("path=<redacted>"));
    assert!(!redacted.contains(&artifacts.script_path.display().to_string()));
    assert!(debug.contains(&artifacts.script_path.display().to_string()));
}

#[test]
fn target_triple_resolver_skips_unsupported_platforms() {
    assert_eq!(
        process::target_triple_for("linux", "x86_64"),
        Some("x86_64-unknown-linux-gnu")
    );
    assert_eq!(process::target_triple_for("windows", "aarch64"), None);
    assert_eq!(process::target_triple_for("freebsd", "x86_64"), None);
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

    let result = summary::result_from_live_metrics(&metrics, Some(0));

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
fn fallback_result_from_live_metrics_marks_non_zero_exit_as_failed() {
    let result = summary::result_from_live_metrics(&LiveMetrics::default(), Some(1));

    assert!(matches!(result.status, TestResultStatus::Failed));
}

#[test]
fn fallback_result_from_live_metrics_marks_unknown_exit_as_failed() {
    let result = summary::result_from_live_metrics(&LiveMetrics::default(), None);

    assert!(matches!(result.status, TestResultStatus::Failed));
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
    assert!(config.has_scenarios);

    let config = process::analyze_advanced_options_json(Some(
        r#"{"stages":[{"duration":"10s","target":10}]}"#,
    ))
    .expect("advanced stage options should parse");
    assert!(config.overrides_basic_load_shape);
    assert!(!config.has_scenarios);

    let config = process::analyze_advanced_options_json(Some(r#"{"tags":{"suite":"api"}}"#))
        .expect("simple advanced options should parse");
    assert!(!config.overrides_basic_load_shape);
    assert!(!config.has_scenarios);
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
        "bundled k6 v2.0.0 should export legacy flat counter fields",
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
fn bundled_k6_handle_summary_file_export_suppresses_native_console_summary() {
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

export function handleSummary(data) {
  const summaryPath = __ENV.LOADRIFT_K6_SUMMARY_PATH;
  return {
    [summaryPath]: JSON.stringify(data, null, 2),
  };
}
"#;

    let script_path =
        process::write_temp_file("js", script).expect("fixture script should be written");
    let summary_path = process::temp_file_path("json");

    let output = Command::new(&k6_binary)
        .arg("run")
        .arg(&script_path)
        .env("LOADRIFT_K6_SUMMARY_PATH", &summary_path)
        .env("K6_NO_COLOR", "true")
        .env("K6_WEB_DASHBOARD", "false")
        .output()
        .expect("bundled k6 should run");

    let _ = fs::remove_file(&script_path);
    let summary_json =
        fs::read_to_string(&summary_path).expect("handleSummary should write the summary file");
    let _ = fs::remove_file(&summary_path);

    assert!(
        output.status.success(),
        "bundled k6 handleSummary execution failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    summary::parse_summary(&summary_json, 1).expect("handleSummary JSON should parse");
    assert!(
        !String::from_utf8_lossy(&output.stdout).contains("TOTAL RESULTS"),
        "handleSummary without a local text-summary renderer should not replace --summary-export yet"
    );
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

fn write_artifact_marker(
    dir: &std::path::Path,
    created_at_unix_seconds: u64,
    preserve_debug: bool,
) {
    write_artifact_marker_with_pid(
        dir,
        created_at_unix_seconds,
        preserve_debug,
        dead_test_pid(),
    );
}

fn write_artifact_marker_with_pid(
    dir: &std::path::Path,
    created_at_unix_seconds: u64,
    preserve_debug: bool,
    pid: u32,
) {
    write_artifact_marker_with_schema(dir, created_at_unix_seconds, preserve_debug, pid, 1);
}

fn write_artifact_marker_with_schema(
    dir: &std::path::Path,
    created_at_unix_seconds: u64,
    preserve_debug: bool,
    pid: u32,
    schema_version: u8,
) {
    let marker = serde_json::json!({
        "owner": "loadrift",
        "kind": "k6-run-artifacts",
        "schemaVersion": schema_version,
        "createdAtUnixSeconds": created_at_unix_seconds,
        "pid": pid,
        "pidRole": "k6Child",
        "preserveDebug": preserve_debug,
    });
    fs::write(
        dir.join(".loadrift-k6-artifacts.json"),
        serde_json::to_string(&marker).expect("marker should serialize"),
    )
    .expect("marker should be written");
}

fn dead_test_pid() -> u32 {
    9_999_999
}

fn bundled_k6_binary() -> Option<PathBuf> {
    let k6_binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join(k6_binary_name());
    if !k6_binary.is_file() {
        if env::var("LOADRIFT_REQUIRE_BUNDLED_K6_TESTS")
            .map(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(false)
        {
            panic!(
                "Bundled k6 regression tests are required but {} is missing. Run `npm run install:k6` before `cargo test`.",
                k6_binary.display()
            );
        }
        eprintln!(
            "Skipping bundled k6 summary test because {} is missing.",
            k6_binary.display()
        );
        return None;
    }

    Some(k6_binary)
}

fn test_running_test() -> RunningTest {
    test_running_test_with_id("run-1")
}

fn test_running_test_with_id(run_id: &str) -> RunningTest {
    let child = Command::new("sh")
        .arg("-c")
        .arg("sleep 0.1")
        .spawn()
        .expect("test child should spawn");

    RunningTest {
        run_id: run_id.to_string(),
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

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn k6_binary_name() -> &'static str {
    "k6-x86_64-apple-darwin"
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn k6_binary_name() -> &'static str {
    "k6-aarch64-apple-darwin"
}

#[cfg(not(any(
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64")
)))]
fn k6_binary_name() -> &'static str {
    "k6"
}
