use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use super::logic::{
    begin_test_start_validation, finalize_test_start_reservation, release_failed_start,
    validate_test_configuration_for_collection, validate_test_configuration_inner,
    wait_for_test_stop,
};
use crate::k6::export_report_file;
use crate::models::{TestStatus, TrafficMode};
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
        latest_result: Some(passed_result()),
        latest_output: "previous output".to_string(),
        ..AppState::default()
    }))
}

#[test]
fn reserve_test_start_blocks_parallel_starts_until_released() {
    let state = state_with_script(empty_runtime_collection());

    let (script, _) =
        begin_test_start_validation(&state).expect("first start should reserve the slot");
    assert!(script.contains("export default function"));

    let error = begin_test_start_validation(&state).expect_err("second start should be rejected");
    assert!(error.contains("already running"));

    release_failed_start(&state);

    begin_test_start_validation(&state).expect("slot should reopen after release");
}

#[test]
fn finalize_test_start_reservation_clears_previous_run_artifacts() {
    let state = state_with_stale_run_artifacts();

    let (script, _) =
        begin_test_start_validation(&state).expect("start reservation should succeed");
    finalize_test_start_reservation(&state, &script)
        .expect("finalizing the reservation should succeed");

    let app_state = state.lock().expect("state should still be readable");
    assert!(app_state.launch_in_progress);
    assert!(app_state.latest_result.is_none());
    assert!(app_state.latest_output.is_empty());
}

#[test]
fn failed_start_leaves_backend_in_failed_state_without_artifacts() {
    let state = state_with_script(empty_runtime_collection());

    begin_test_start_validation(&state).expect("start reservation should succeed");
    release_failed_start(&state);

    let app_state = state.lock().expect("state should still be readable");
    assert!(!app_state.launch_in_progress);
    assert!(matches!(app_state.test_status, TestStatus::Failed));
    assert!(app_state.latest_result.is_none());
}

#[test]
fn failed_start_cannot_export_previous_report() {
    let state = state_with_stale_run_artifacts();

    let (script, _) =
        begin_test_start_validation(&state).expect("start reservation should succeed");
    finalize_test_start_reservation(&state, &script)
        .expect("finalizing the reservation should succeed");
    release_failed_start(&state);

    let error = export_report_file(&state, "/tmp/loadrift-review-report.html")
        .expect_err("stale report data should not remain exportable");
    assert!(error.contains("Run a k6 test before exporting a report."));
}

#[test]
fn wait_for_test_stop_returns_when_active_test_clears() {
    let child = Command::new("sh")
        .arg("-c")
        .arg("sleep 0.1")
        .spawn()
        .expect("test child should spawn");
    let state = Arc::new(Mutex::new(AppState {
        active_test: Some(RunningTest {
            child: Arc::new(Mutex::new(child)),
            stop_requested: Arc::new(AtomicBool::new(false)),
        }),
        ..AppState::default()
    }));

    let state_for_clear = state.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(50));
        if let Ok(mut app_state) = state_for_clear.lock() {
            app_state.active_test = None;
        }
    });

    wait_for_test_stop(&state).expect("active test should clear before timeout");
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
            "Configuration looks ready to run. Weighted mix prefers generated per-request scenarios when VU capacity allows, otherwise deterministic weighted scheduling per iteration."
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
