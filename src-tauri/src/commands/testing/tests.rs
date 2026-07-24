use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use super::logic::{
    begin_test_start_validation, finalize_test_start_reservation, finalize_test_stop,
    get_test_status_response, release_failed_start, request_test_stop,
    reserve_and_resolve_smoke_test, validate_test_configuration_for_collection,
    validate_test_configuration_inner, wait_for_test_stop, TestStopRequest,
};
use super::run_reserved_smoke_test;
use crate::k6::export_report_file;
use crate::models::{LiveMetrics, TestResultSource, TestStatus, TrafficMode};
use crate::state::{AppState, RunningTest};
use crate::test_support::{
    empty_runtime_collection, passed_result, runtime_collection, runtime_request,
    runtime_request_with_headers, test_k6_options,
};

fn state_with_script(
    runtime_collection: crate::importing::RuntimeCollection,
) -> Arc<Mutex<AppState>> {
    Arc::new(Mutex::new(AppState {
        generated_script: Some("export default function () {}".to_string()),
        runtime_collection: Some(runtime_collection),
        ..AppState::default()
    }))
}

fn state_with_stale_run_artifacts() -> Arc<Mutex<AppState>> {
    Arc::new(Mutex::new(AppState {
        generated_script: Some("export default function () {}".to_string()),
        runtime_collection: Some(empty_runtime_collection()),
        latest_metrics: Some(LiveMetrics::default()),
        latest_result: Some(passed_result()),
        latest_summary_json: Some("{\"metrics\":{}}".to_string()),
        latest_finish_reason: Some("completed".to_string()),
        latest_error_message: Some("old error".to_string()),
        latest_result_source: Some(TestResultSource::Summary),
        latest_summary_issue: Some("old summary issue".to_string()),
        latest_output: "previous output".to_string(),
        ..AppState::default()
    }))
}

fn state_with_smoke_request() -> Arc<Mutex<AppState>> {
    state_with_script(runtime_collection(vec![runtime_request(
        "GET users",
        "/users",
    )]))
}

#[test]
fn reserve_test_start_blocks_parallel_starts_until_released() {
    let state = state_with_script(empty_runtime_collection());

    let (script, _) =
        begin_test_start_validation(&state, "run-1").expect("first start should reserve the slot");
    assert!(script.contains("export default function"));

    let error =
        begin_test_start_validation(&state, "run-2").expect_err("second start should be rejected");
    assert!(error.contains("already running"));

    release_failed_start(&state, "run-1");

    begin_test_start_validation(&state, "run-2").expect("slot should reopen after release");
}

#[test]
fn smoke_reservation_blocks_smoke_and_load_start_without_changing_k6_status() {
    let state = state_with_smoke_request();
    let options = test_k6_options(Some("https://api.example.com"));

    let (_, reservation) = reserve_and_resolve_smoke_test(&state, &options)
        .expect("first smoke test should reserve the operation");

    let smoke_error = reserve_and_resolve_smoke_test(&state, &options)
        .expect_err("parallel smoke test should be rejected");
    assert!(smoke_error.contains("load or smoke test is already running"));

    let load_error = begin_test_start_validation(&state, "run-during-smoke")
        .expect_err("load start should reject an active smoke test");
    assert!(load_error.contains("load or smoke test is already running"));

    let status = get_test_status_response(&state).expect("k6 status should remain readable");
    assert!(!status.is_running);
    assert!(matches!(status.status, TestStatus::Idle));

    drop(reservation);
    begin_test_start_validation(&state, "run-after-smoke")
        .expect("load start should succeed after the smoke reservation releases");
}

#[test]
fn active_load_start_blocks_smoke_reservation() {
    let state = state_with_smoke_request();
    let options = test_k6_options(Some("https://api.example.com"));
    begin_test_start_validation(&state, "run-1").expect("load start should reserve the operation");

    let error = reserve_and_resolve_smoke_test(&state, &options)
        .expect_err("smoke test should reject an active load start");

    assert!(error.contains("load or smoke test is already running"));
    release_failed_start(&state, "run-1");
}

#[test]
fn smoke_reservation_releases_after_resolution_error() {
    let state = state_with_smoke_request();
    let mut invalid_options = test_k6_options(Some("https://api.example.com"));
    invalid_options.selected_request_ids.clear();

    reserve_and_resolve_smoke_test(&state, &invalid_options)
        .expect_err("invalid smoke options should fail resolution");
    assert!(
        !state
            .lock()
            .expect("state should remain readable")
            .smoke_test_in_progress
    );

    reserve_and_resolve_smoke_test(&state, &test_k6_options(Some("https://api.example.com")))
        .expect("reservation should reopen after resolution failure");
}

#[test]
fn smoke_reservation_releases_after_worker_success_and_execution_error() {
    let state = state_with_smoke_request();
    let options = test_k6_options(Some("https://api.example.com"));

    let (_, success_reservation) = reserve_and_resolve_smoke_test(&state, &options)
        .expect("successful worker should reserve the operation");
    run_reserved_smoke_test(Vec::new(), success_reservation)
        .expect("empty worker fixture should complete successfully");
    assert!(
        !state
            .lock()
            .expect("state should remain readable")
            .smoke_test_in_progress
    );

    let (resolved, error_reservation) = reserve_and_resolve_smoke_test(&state, &options)
        .expect("error worker should reserve the operation");
    let excessive_requests = (0..26).map(|_| resolved[0].clone()).collect();
    run_reserved_smoke_test(excessive_requests, error_reservation)
        .expect_err("request limit should fail smoke execution");
    assert!(
        !state
            .lock()
            .expect("state should remain readable")
            .smoke_test_in_progress
    );
}

#[test]
fn smoke_reservation_releases_when_worker_panics() {
    let state = state_with_smoke_request();
    let (_, reservation) =
        reserve_and_resolve_smoke_test(&state, &test_k6_options(Some("https://api.example.com")))
            .expect("worker should reserve the operation");

    let worker = thread::spawn(move || {
        let _reservation = reservation;
        panic!("representative blocking worker panic");
    });

    assert!(worker.join().is_err());
    assert!(
        !state
            .lock()
            .expect("state should remain readable")
            .smoke_test_in_progress
    );
}

#[test]
fn detached_smoke_worker_keeps_reservation_until_blocking_work_finishes() {
    let state = state_with_smoke_request();
    let options = test_k6_options(Some("https://api.example.com"));
    let (_, reservation) = reserve_and_resolve_smoke_test(&state, &options)
        .expect("worker should reserve the operation");
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();

    let worker = thread::spawn(move || {
        let reservation = reservation;
        started_tx.send(()).expect("worker should report start");
        release_rx.recv().expect("worker should receive release");
        drop(reservation);
        finished_tx.send(()).expect("worker should report finish");
    });
    drop(worker);
    started_rx.recv().expect("detached worker should start");

    reserve_and_resolve_smoke_test(&state, &options)
        .expect_err("detached join ownership must not release active blocking work");
    release_tx.send(()).expect("worker should be released");
    finished_rx.recv().expect("detached worker should finish");

    reserve_and_resolve_smoke_test(&state, &options)
        .expect("reservation should reopen when detached blocking work finishes");
}

#[test]
fn run_ids_cannot_be_reused_after_a_failed_start() {
    let state = state_with_script(empty_runtime_collection());

    begin_test_start_validation(&state, "run-1").expect("first reservation should succeed");
    release_failed_start(&state, "run-1");

    let error = begin_test_start_validation(&state, "run-1")
        .expect_err("a failed run id must remain consumed");
    assert!(error.contains("already been used"));
}

#[test]
fn run_ids_cannot_be_reused_after_intervening_runs() {
    let state = state_with_script(empty_runtime_collection());

    begin_test_start_validation(&state, "run-1").expect("first reservation should succeed");
    release_failed_start(&state, "run-1");
    begin_test_start_validation(&state, "run-2").expect("second reservation should succeed");
    release_failed_start(&state, "run-2");

    let error = begin_test_start_validation(&state, "run-1")
        .expect_err("an older run id must not become reusable");
    assert!(error.contains("already been used"));
}

#[test]
fn run_ids_cannot_be_reused_after_completion() {
    let state = state_with_script(empty_runtime_collection());

    begin_test_start_validation(&state, "run-1").expect("reservation should succeed");
    {
        let mut app_state = state.lock().expect("state should be writable");
        app_state.launch_in_progress = false;
        app_state.test_status = TestStatus::Completed;
    }

    let error = begin_test_start_validation(&state, "run-1")
        .expect_err("a completed run id must remain consumed");
    assert!(error.contains("already been used"));
}

#[test]
fn rejected_parallel_start_does_not_consume_its_run_id() {
    let state = state_with_script(empty_runtime_collection());

    begin_test_start_validation(&state, "run-1").expect("first reservation should succeed");
    begin_test_start_validation(&state, "run-2")
        .expect_err("parallel reservation should be rejected while busy");
    release_failed_start(&state, "run-1");

    begin_test_start_validation(&state, "run-2")
        .expect("an id rejected before reservation should still be available");
}

#[test]
fn reserving_test_start_clears_previous_run_artifacts_before_finalization() {
    let state = state_with_stale_run_artifacts();

    let (script, runtime_collection) =
        begin_test_start_validation(&state, "run-1").expect("start reservation should succeed");

    let app_state = state.lock().expect("state should still be readable");
    assert!(app_state.launch_in_progress);
    assert_eq!(app_state.generated_script.as_deref(), Some(script.as_str()));
    assert_eq!(
        app_state
            .runtime_collection
            .as_ref()
            .map(|collection| collection.requests.len()),
        Some(runtime_collection.requests.len())
    );
    assert!(app_state.latest_metrics.is_none());
    assert!(app_state.latest_result.is_none());
    assert!(app_state.latest_summary_json.is_none());
    assert!(app_state.latest_finish_reason.is_none());
    assert!(app_state.latest_error_message.is_none());
    assert!(app_state.latest_result_source.is_none());
    assert!(app_state.latest_summary_issue.is_none());
    assert!(app_state.latest_output.is_empty());
}

#[test]
fn finalizing_test_start_does_not_clear_post_reservation_state_again() {
    let state = state_with_stale_run_artifacts();

    let (script, _) =
        begin_test_start_validation(&state, "run-1").expect("start reservation should succeed");
    state
        .lock()
        .expect("state should still be writable")
        .latest_output = "startup diagnostic".to_string();

    finalize_test_start_reservation(&state, &script, "run-1")
        .expect("finalizing the reservation should succeed");

    assert_eq!(
        state
            .lock()
            .expect("state should still be readable")
            .latest_output,
        "startup diagnostic"
    );
}

#[test]
fn failed_start_leaves_backend_in_failed_state_without_artifacts() {
    let state = state_with_stale_run_artifacts();

    let (_, runtime_collection) =
        begin_test_start_validation(&state, "run-1").expect("start reservation should succeed");
    let mut invalid_options = test_k6_options(Some("https://api.example.com"));
    invalid_options.selected_request_ids.clear();
    assert!(
        validate_test_configuration_for_collection(&runtime_collection, &invalid_options).is_some()
    );
    release_failed_start(&state, "run-1");

    let app_state = state.lock().expect("state should still be readable");
    assert!(!app_state.launch_in_progress);
    assert!(matches!(app_state.test_status, TestStatus::Failed));
    assert_eq!(app_state.latest_run_id.as_deref(), Some("run-1"));
    assert!(app_state.latest_result.is_none());
    assert!(app_state.latest_summary_json.is_none());
    assert!(app_state.latest_output.is_empty());
}

#[test]
fn test_status_response_includes_latest_run_id() {
    let state = Arc::new(Mutex::new(AppState {
        latest_run_id: Some("run-1".to_string()),
        test_status: TestStatus::Completed,
        ..AppState::default()
    }));

    let response = get_test_status_response(&state).expect("status should be readable");

    assert_eq!(response.run_id.as_deref(), Some("run-1"));
    assert!(matches!(response.status, TestStatus::Completed));
}

#[test]
fn failed_start_cannot_export_previous_report() {
    let state = state_with_stale_run_artifacts();

    begin_test_start_validation(&state, "run-1").expect("start reservation should succeed");
    release_failed_start(&state, "run-1");

    let error = export_report_file(&state, "/tmp/loadrift-review-report.html")
        .expect_err("stale report data should not remain exportable");
    assert!(error.contains("Run a k6 test before exporting a report."));
}

#[test]
fn launch_failure_after_finalization_keeps_reserved_run_failed_and_empty() {
    let state = state_with_stale_run_artifacts();

    let (script, _) =
        begin_test_start_validation(&state, "run-1").expect("start reservation should succeed");
    finalize_test_start_reservation(&state, &script, "run-1")
        .expect("start reservation should finalize");
    release_failed_start(&state, "run-1");

    let app_state = state.lock().expect("state should be readable");
    assert_eq!(app_state.latest_run_id.as_deref(), Some("run-1"));
    assert!(matches!(app_state.test_status, TestStatus::Failed));
    assert!(app_state.latest_result.is_none());
    assert!(app_state.latest_summary_json.is_none());
    assert!(app_state.latest_output.is_empty());
}

#[test]
fn requested_stop_waits_for_its_active_run_to_clear() {
    let child = Command::new("sh")
        .arg("-c")
        .arg("sleep 0.1")
        .spawn()
        .expect("test child should spawn");
    let state = Arc::new(Mutex::new(AppState {
        latest_run_id: Some("run-1".to_string()),
        test_status: TestStatus::Running,
        active_test: Some(RunningTest {
            run_id: "run-1".to_string(),
            child: Arc::new(Mutex::new(child)),
            stop_requested: Arc::new(AtomicBool::new(false)),
        }),
        ..AppState::default()
    }));

    let TestStopRequest::Requested { run_id, .. } =
        request_test_stop(&state).expect("active stop should be accepted")
    else {
        panic!("active stop should not be treated as already stopped");
    };
    assert_eq!(run_id, "run-1");
    wait_for_test_stop(&state, "older-run")
        .expect("a stale stop waiter must not wait on the current run");

    let state_for_clear = state.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(50));
        if let Ok(mut app_state) = state_for_clear.lock() {
            app_state.active_test = None;
        }
    });

    wait_for_test_stop(&state, &run_id).expect("active test should clear before timeout");
}

#[test]
fn repeated_stop_requests_for_latest_stopped_run_are_idempotent() {
    let state = Arc::new(Mutex::new(AppState {
        latest_run_id: Some("run-1".to_string()),
        test_status: TestStatus::Stopped,
        ..AppState::default()
    }));

    assert!(matches!(
        request_test_stop(&state).expect("first repeated stop should succeed"),
        TestStopRequest::AlreadyStopped
    ));
    assert!(matches!(
        request_test_stop(&state).expect("second repeated stop should succeed"),
        TestStopRequest::AlreadyStopped
    ));
}

#[test]
fn stop_without_any_run_remains_an_error() {
    let state = Arc::new(Mutex::new(AppState::default()));

    let error = request_test_stop(&state).expect_err("no-run stop should be rejected");
    assert!(error.contains("No k6 test is currently running"));
}

#[test]
fn stop_after_completed_run_remains_an_error() {
    let state = Arc::new(Mutex::new(AppState {
        latest_run_id: Some("run-1".to_string()),
        test_status: TestStatus::Completed,
        ..AppState::default()
    }));

    let error = request_test_stop(&state).expect_err("completed-run stop should be rejected");
    assert!(error.contains("already completed"));
}

#[test]
fn stop_reports_poisoned_shared_state() {
    let state = Arc::new(Mutex::new(AppState::default()));
    let poison_state = state.clone();
    let _ = thread::spawn(move || {
        let _guard = poison_state.lock().expect("state should initially lock");
        panic!("poison state for the test");
    })
    .join();

    let error = request_test_stop(&state).expect_err("poisoned state should be reported");
    assert!(error.contains("Failed to read the shared Tauri app state"));
}

#[test]
fn accepted_stop_can_settle_after_child_completion_wins_the_race() {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg("exit 0")
        .spawn()
        .expect("test child should spawn");
    child.wait().expect("test child should already be exited");
    let state = Arc::new(Mutex::new(AppState {
        latest_run_id: Some("run-1".to_string()),
        test_status: TestStatus::Running,
        active_test: Some(RunningTest {
            run_id: "run-1".to_string(),
            child: Arc::new(Mutex::new(child)),
            stop_requested: Arc::new(AtomicBool::new(false)),
        }),
        ..AppState::default()
    }));

    assert!(matches!(
        request_test_stop(&state).expect("exited active child should accept stop"),
        TestStopRequest::Requested { .. }
    ));
    {
        let mut app_state = state.lock().expect("state should be writable");
        app_state.active_test = None;
        app_state.test_status = TestStatus::Completed;
    }
    wait_for_test_stop(&state, "run-1").expect("exited child should be settled");
    finalize_test_stop(&state, "run-1").expect("accepted stop should settle as stopped");

    assert!(matches!(
        state.lock().expect("state should be readable").test_status,
        TestStatus::Stopped
    ));
    assert_eq!(
        state
            .lock()
            .expect("state should be readable")
            .latest_finish_reason
            .as_deref(),
        Some("stopped")
    );
}

#[test]
fn old_stop_settlement_does_not_overwrite_newer_run() {
    let state = Arc::new(Mutex::new(AppState {
        latest_run_id: Some("run-2".to_string()),
        test_status: TestStatus::Completed,
        latest_result: Some(passed_result()),
        ..AppState::default()
    }));

    finalize_test_stop(&state, "run-1").expect("stale stop settlement should be ignored");

    let app_state = state.lock().expect("state should be readable");
    assert_eq!(app_state.latest_run_id.as_deref(), Some("run-2"));
    assert!(matches!(app_state.test_status, TestStatus::Completed));
    assert!(app_state.latest_result.is_some());
}

#[test]
fn failed_start_release_does_not_overwrite_newer_reservation() {
    let state = state_with_script(empty_runtime_collection());
    begin_test_start_validation(&state, "run-1").expect("first reservation should succeed");
    {
        let mut app_state = state.lock().expect("state should be writable");
        app_state.latest_run_id = Some("run-2".to_string());
        app_state.test_status = TestStatus::Running;
    }

    release_failed_start(&state, "run-1");

    let app_state = state.lock().expect("state should be readable");
    assert_eq!(app_state.latest_run_id.as_deref(), Some("run-2"));
    assert!(app_state.launch_in_progress);
    assert!(matches!(app_state.test_status, TestStatus::Running));
}

#[test]
fn validate_test_configuration_reports_missing_collection() {
    let state = Arc::new(Mutex::new(AppState::default()));

    let response = validate_test_configuration_inner(
        &state,
        &test_k6_options(Some("https://api.example.com")),
    );
    assert!(!response.ready);
    assert!(response
        .message
        .as_deref()
        .unwrap_or_default()
        .contains("Import a Postman collection"));
}

#[test]
fn validate_test_configuration_reports_busy_runner_as_not_ready() {
    let state = Arc::new(Mutex::new(AppState {
        launch_in_progress: true,
        runtime_collection: Some(runtime_collection(vec![runtime_request(
            "GET users",
            "/users",
        )])),
        ..AppState::default()
    }));

    let response = validate_test_configuration_inner(
        &state,
        &test_k6_options(Some("https://api.example.com")),
    );
    assert!(!response.ready);
    assert!(response
        .message
        .as_deref()
        .unwrap_or_default()
        .contains("already running or still shutting down"));
}

#[test]
fn validate_test_configuration_reports_ready_for_valid_collection() {
    let state = Arc::new(Mutex::new(AppState {
        runtime_collection: Some(runtime_collection(vec![runtime_request(
            "GET users",
            "/users",
        )])),
        ..AppState::default()
    }));

    let response = validate_test_configuration_inner(
        &state,
        &test_k6_options(Some("https://api.example.com")),
    );
    assert!(response.ready);
    assert_eq!(
        response.message.as_deref(),
        Some("Configuration looks ready to run.")
    );
}

#[test]
fn validate_test_configuration_reports_weighted_mode_ready_message() {
    let state = Arc::new(Mutex::new(AppState {
        runtime_collection: Some(runtime_collection(vec![runtime_request(
            "GET users",
            "/users",
        )])),
        ..AppState::default()
    }));
    let mut options = test_k6_options(Some("https://api.example.com"));
    options.traffic_mode = TrafficMode::Weighted;

    let response = validate_test_configuration_inner(&state, &options);
    assert!(response.ready);
    assert_eq!(
        response.message.as_deref(),
        Some(
            "Configuration looks ready to run. Weighted mix uses deterministic request scheduling per iteration; weight 0 excludes a request from the weighted pool."
        )
    );
}

#[test]
fn validate_test_configuration_requires_at_least_one_selected_request() {
    let state = Arc::new(Mutex::new(AppState {
        runtime_collection: Some(runtime_collection(vec![runtime_request(
            "GET users",
            "/users",
        )])),
        ..AppState::default()
    }));
    let mut options = test_k6_options(Some("https://api.example.com"));
    options.selected_request_ids.clear();

    let response = validate_test_configuration_inner(&state, &options);
    assert!(!response.ready);
    assert_eq!(
        response.message.as_deref(),
        Some("Select at least one request to run.")
    );
}

#[test]
fn validate_test_configuration_rejects_zero_weight_for_selected_weighted_requests() {
    let state = Arc::new(Mutex::new(AppState {
        runtime_collection: Some(runtime_collection(vec![runtime_request(
            "GET users",
            "/users",
        )])),
        ..AppState::default()
    }));
    let mut options = test_k6_options(Some("https://api.example.com"));
    options.traffic_mode = TrafficMode::Weighted;
    options.request_weights.insert("request-0".to_string(), 0);

    let response = validate_test_configuration_inner(&state, &options);
    assert!(!response.ready);
    assert_eq!(
        response.message.as_deref(),
        Some("Weighted mix requires at least one selected request with a positive weight.")
    );
}

#[test]
fn validate_test_configuration_allows_mixed_zero_and_positive_weighted_requests() {
    let state = Arc::new(Mutex::new(AppState {
        runtime_collection: Some(runtime_collection(vec![
            runtime_request("GET users", "/users"),
            runtime_request("GET teams", "/teams"),
        ])),
        ..AppState::default()
    }));
    let mut options = test_k6_options(Some("https://api.example.com"));
    options.traffic_mode = TrafficMode::Weighted;
    options.selected_request_ids = vec!["request-0".to_string(), "request-1".to_string()];
    options.request_weights.insert("request-0".to_string(), 0);
    options.request_weights.insert("request-1".to_string(), 2);

    let response = validate_test_configuration_inner(&state, &options);
    assert!(response.ready);
}

#[test]
fn validate_test_configuration_reports_advanced_scenarios_override_weighted_mode() {
    let state = Arc::new(Mutex::new(AppState {
        runtime_collection: Some(runtime_collection(vec![runtime_request(
            "GET users",
            "/users",
        )])),
        ..AppState::default()
    }));
    let mut options = test_k6_options(Some("https://api.example.com"));
    options.traffic_mode = TrafficMode::Weighted;
    options.advanced_options_json = Some(
        r#"{"scenarios":{"steady":{"executor":"shared-iterations","vus":1,"iterations":1}}}"#
            .to_string(),
    );

    let response = validate_test_configuration_inner(&state, &options);
    assert!(response.ready);
    assert_eq!(
        response.message.as_deref(),
        Some(
            "Configuration looks ready to run. Advanced k6 scenarios override the built-in weighted mix settings. Use advanced scenarios/executors for stricter fixed traffic ratios."
        )
    );
}

#[test]
fn validate_test_configuration_guides_user_to_apply_curl_for_host_placeholders() {
    let state = Arc::new(Mutex::new(AppState {
        runtime_collection: Some(runtime_collection(vec![runtime_request(
            "registration DE Copy",
            "{{environment}}/users",
        )])),
        ..AppState::default()
    }));

    let mut options = test_k6_options(Some("https://api.example.com"));
    options.base_url = None;

    let response = validate_test_configuration_inner(&state, &options);
    assert!(!response.ready);
    assert_eq!(
        response.message.as_deref(),
        Some("Apply a Postman cURL snippet to derive the base URL required by this collection.")
    );
}

#[test]
fn strict_collection_validation_keeps_raw_error_for_start_attempts() {
    let runtime_collection = runtime_collection(vec![runtime_request(
        "registration DE Copy",
        "{{environment}}/users",
    )]);

    let mut options = test_k6_options(Some("https://api.example.com"));
    options.base_url = None;

    let error = validate_test_configuration_for_collection(&runtime_collection, &options)
        .expect("strict validation should still reject missing derived base urls");
    assert!(error.contains("unresolved variables in the URL"));
}

#[test]
fn config_validation_keeps_header_errors_when_collection_also_uses_host_placeholders() {
    let state = Arc::new(Mutex::new(AppState {
        runtime_collection: Some(runtime_collection(vec![runtime_request_with_headers(
            "registration DE Copy",
            "{{environment}}/users",
            [("X-Customer".to_string(), "{{customerId}}".to_string())]
                .into_iter()
                .collect(),
        )])),
        ..AppState::default()
    }));

    let mut options = test_k6_options(Some("https://api.example.com"));
    options.base_url = None;

    let response = validate_test_configuration_inner(&state, &options);
    assert!(!response.ready);
    assert_eq!(
        response.message.as_deref(),
        Some(
            "Request \"registration DE Copy\" still contains unresolved variables in headers: customerId"
        )
    );
}

#[test]
fn config_validation_keeps_mixed_url_variable_errors_when_base_url_alone_is_not_enough() {
    let state = Arc::new(Mutex::new(AppState {
        runtime_collection: Some(runtime_collection(vec![runtime_request(
            "registration DE Copy",
            "{{environment}}/users/{{customerId}}",
        )])),
        ..AppState::default()
    }));

    let mut options = test_k6_options(Some("https://api.example.com"));
    options.base_url = None;

    let response = validate_test_configuration_inner(&state, &options);
    assert!(!response.ready);
    assert_eq!(
        response.message.as_deref(),
        Some(
            "Request \"registration DE Copy\" still contains unresolved variables in the URL: customerId, environment"
        )
    );
}
