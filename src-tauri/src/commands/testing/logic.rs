use std::sync::atomic::Ordering;
use std::thread;
use std::time::{Duration, Instant};

use crate::importing::{
    resolve_test_requests, validate_test_run, ResolvedRuntimeRequest, RuntimeCollection,
};
use crate::k6::{analyze_advanced_options_json, validate_advanced_options_json};
use crate::models::{
    GetTestStatusResponse, K6Options, TestStatus, TrafficMode, ValidateTestConfigurationResponse,
};
use crate::state::SharedAppState;

const READ_STATE_ERROR: &str = "Failed to read the shared Tauri app state.";
const RUNNER_BUSY_START_ERROR: &str =
    "A load or smoke test is already running or still shutting down. Wait a moment and try again.";
const RUNNER_BUSY_VALIDATE_ERROR: &str =
    "A k6 test is already running or still shutting down. Wait a moment before starting another run.";
const IMPORT_BEFORE_START_ERROR: &str = "Import a Postman collection before starting a k6 test.";
const IMPORT_BEFORE_VALIDATE_ERROR: &str =
    "Import a Postman collection before validating the k6 settings.";
const IMPORT_BEFORE_SMOKE_TEST_ERROR: &str =
    "Import a Postman collection before running a smoke test.";
const RUNNER_BUSY_SMOKE_TEST_ERROR: &str =
    "A load or smoke test is already running or still shutting down. Wait a moment before running a smoke test.";
const CANCELLED_START_ERROR: &str = "The pending k6 test start was cancelled before launch.";
const REUSED_RUN_ID_ERROR: &str =
    "This k6 run id has already been used. Start again with a new run id.";
const WAIT_FOR_STOP_TIMEOUT_ERROR: &str =
    "Timed out while waiting for the active k6 test to shut down.";
const NO_RUNNING_TEST_ERROR: &str = "No k6 test is currently running.";
const COMPLETED_TEST_STOP_ERROR: &str =
    "The latest k6 test has already completed and cannot be stopped.";
const FAILED_TEST_STOP_ERROR: &str = "The latest k6 test has already failed and cannot be stopped.";
const STOPPED_FINISH_REASON: &str = "stopped";
const READY_TO_RUN_MESSAGE: &str = "Configuration looks ready to run.";
const BASE_URL_GUIDANCE: &str =
    "Apply a Postman cURL snippet to derive the base URL required by this collection.";
const ADVANCED_SCENARIOS_OVERRIDE_TRAFFIC_MODE_MESSAGE: &str =
    "Configuration looks ready to run. Advanced k6 scenarios override the built-in weighted mix settings. Use advanced scenarios/executors for stricter fixed traffic ratios.";
const WEIGHTED_MODE_READY_MESSAGE: &str =
    "Configuration looks ready to run. Weighted mix uses deterministic request scheduling per iteration; weight 0 excludes a request from the weighted pool.";

pub(super) fn get_test_status_response(
    state: &SharedAppState,
) -> Result<GetTestStatusResponse, String> {
    let state = state.lock().map_err(|_| READ_STATE_ERROR.to_string())?;
    let is_running = state.test_is_busy();
    let status = if is_running {
        TestStatus::Running
    } else {
        state.test_status.clone()
    };

    Ok(GetTestStatusResponse {
        run_id: state.latest_run_id.clone(),
        status,
        is_running,
        metrics: state.latest_metrics.clone(),
        result: state.latest_result.clone(),
        finish_reason: state.latest_finish_reason.clone(),
        error_message: state.latest_error_message.clone(),
        result_source: state.latest_result_source.clone(),
        summary_issue: state.latest_summary_issue.clone(),
    })
}

pub(super) fn begin_test_start_validation(
    state: &SharedAppState,
    run_id: &str,
) -> Result<(String, RuntimeCollection), String> {
    let mut app_state = state.lock().map_err(|_| READ_STATE_ERROR.to_string())?;

    if app_state.test_operation_is_busy() {
        return Err(RUNNER_BUSY_START_ERROR.to_string());
    }

    let script = app_state
        .generated_script
        .clone()
        .ok_or(IMPORT_BEFORE_START_ERROR.to_string())?;
    let runtime_collection = app_state
        .runtime_collection
        .clone()
        .ok_or(IMPORT_BEFORE_START_ERROR.to_string())?;

    if !app_state.used_run_ids.insert(run_id.to_string()) {
        return Err(REUSED_RUN_ID_ERROR.to_string());
    }

    // The reservation is the boundary between runs. Clear the previous run's
    // exportable state here, before validation or process launch can fail.
    app_state.clear_test_run_state();
    app_state.launch_in_progress = true;
    app_state.latest_run_id = Some(run_id.to_string());
    app_state.test_status = TestStatus::Idle;

    Ok((script, runtime_collection))
}

pub(super) fn finalize_test_start_reservation(
    state: &SharedAppState,
    script: &str,
    run_id: &str,
) -> Result<String, String> {
    let mut app_state = state.lock().map_err(|_| READ_STATE_ERROR.to_string())?;

    if app_state.active_test.is_some() {
        return Err(RUNNER_BUSY_START_ERROR.to_string());
    }

    if !app_state.launch_in_progress || app_state.latest_run_id.as_deref() != Some(run_id) {
        return Err(CANCELLED_START_ERROR.to_string());
    }

    app_state.test_status = TestStatus::Idle;

    Ok(script.to_string())
}

pub(super) fn release_failed_start(state: &SharedAppState, run_id: &str) {
    if let Ok(mut app_state) = state.lock() {
        if app_state.latest_run_id.as_deref() != Some(run_id) {
            return;
        }

        app_state.launch_in_progress = false;
        if app_state.active_test.is_none() {
            app_state.test_status = TestStatus::Failed;
        }
    }
}

pub(super) fn validate_test_configuration_inner(
    state: &SharedAppState,
    options: &K6Options,
) -> ValidateTestConfigurationResponse {
    let runtime_collection = match state.lock() {
        Ok(app_state) => {
            if app_state.test_is_busy() {
                return not_ready(RUNNER_BUSY_VALIDATE_ERROR);
            }

            app_state.runtime_collection.clone()
        }
        Err(_) => {
            return not_ready(READ_STATE_ERROR);
        }
    };

    let Some(runtime_collection) = runtime_collection else {
        return not_ready(IMPORT_BEFORE_VALIDATE_ERROR);
    };

    let advanced_options_define_scenarios = advanced_options_has_scenarios(options);

    match validate_test_configuration_for_collection(&runtime_collection, options) {
        None => ValidateTestConfigurationResponse {
            ready: true,
            message: Some(ready_message(options, advanced_options_define_scenarios)),
        },
        Some(message) => {
            let message = if should_show_base_url_guidance(options, &message) {
                BASE_URL_GUIDANCE.to_string()
            } else {
                message
            };

            ValidateTestConfigurationResponse {
                ready: false,
                message: Some(message),
            }
        }
    }
}

pub(super) struct SmokeTestReservation {
    state: SharedAppState,
}

impl std::fmt::Debug for SmokeTestReservation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SmokeTestReservation")
    }
}

impl Drop for SmokeTestReservation {
    fn drop(&mut self) {
        let mut app_state = match self.state.lock() {
            Ok(app_state) => app_state,
            Err(poisoned) => poisoned.into_inner(),
        };
        app_state.smoke_test_in_progress = false;
    }
}

pub(super) fn reserve_and_resolve_smoke_test(
    state: &SharedAppState,
    options: &K6Options,
) -> Result<(Vec<ResolvedRuntimeRequest>, SmokeTestReservation), String> {
    let runtime_collection = {
        let mut app_state = state.lock().map_err(|_| READ_STATE_ERROR.to_string())?;

        if app_state.test_operation_is_busy() {
            return Err(RUNNER_BUSY_SMOKE_TEST_ERROR.to_string());
        }

        let runtime_collection = app_state
            .runtime_collection
            .clone()
            .ok_or(IMPORT_BEFORE_SMOKE_TEST_ERROR.to_string())?;
        app_state.smoke_test_in_progress = true;
        runtime_collection
    };
    let reservation = SmokeTestReservation {
        state: state.clone(),
    };
    let requests = resolve_test_requests(&runtime_collection, options)?;

    Ok((requests, reservation))
}

pub(super) fn validate_test_configuration_for_collection(
    runtime_collection: &RuntimeCollection,
    options: &K6Options,
) -> Option<String> {
    if let Err(error) = validate_advanced_options_json(options.advanced_options_json.as_deref()) {
        return Some(error);
    }

    if let Err(error) = validate_test_run(runtime_collection, options) {
        return Some(error);
    }

    None
}

fn should_show_base_url_guidance(options: &K6Options, validation_error: &str) -> bool {
    let has_configured_base_url = options
        .base_url
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    if has_configured_base_url {
        return false;
    }

    let Some((_, missing_variables)) =
        validation_error.split_once("unresolved variables in the URL:")
    else {
        return false;
    };

    let missing_variables: Vec<&str> = missing_variables
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();
    !missing_variables.is_empty()
        && missing_variables
            .iter()
            .all(|key| matches!(*key, "baseUrl" | "base_url" | "environment" | "enviroment"))
}

fn ready_message(options: &K6Options, advanced_options_define_scenarios: bool) -> String {
    if options.traffic_mode == TrafficMode::Weighted && advanced_options_define_scenarios {
        return ADVANCED_SCENARIOS_OVERRIDE_TRAFFIC_MODE_MESSAGE.to_string();
    }

    if options.traffic_mode == TrafficMode::Weighted {
        return WEIGHTED_MODE_READY_MESSAGE.to_string();
    }

    READY_TO_RUN_MESSAGE.to_string()
}

fn advanced_options_has_scenarios(options: &K6Options) -> bool {
    analyze_advanced_options_json(options.advanced_options_json.as_deref())
        .map(|config| config.has_scenarios)
        .unwrap_or(false)
}

#[derive(Debug)]
pub(super) enum TestStopRequest {
    AlreadyStopped,
    Requested {
        run_id: String,
        process_error: Option<String>,
    },
}

pub(super) fn request_test_stop(state: &SharedAppState) -> Result<TestStopRequest, String> {
    let running = {
        let app_state = state.lock().map_err(|_| READ_STATE_ERROR.to_string())?;

        if let Some(active) = app_state.active_test.as_ref() {
            active.stop_requested.store(true, Ordering::SeqCst);
            active.clone()
        } else {
            return match app_state.test_status.clone() {
                TestStatus::Stopped if app_state.latest_run_id.is_some() => {
                    Ok(TestStopRequest::AlreadyStopped)
                }
                TestStatus::Completed => Err(COMPLETED_TEST_STOP_ERROR.to_string()),
                TestStatus::Failed => Err(FAILED_TEST_STOP_ERROR.to_string()),
                TestStatus::Idle | TestStatus::Running | TestStatus::Stopped => {
                    Err(NO_RUNNING_TEST_ERROR.to_string())
                }
            };
        }
    };

    let process_error = {
        let mut child = match running.child.lock() {
            Ok(child) => child,
            Err(poisoned) => poisoned.into_inner(),
        };
        child
            .kill()
            .err()
            .map(|error| format!("Failed to stop the active k6 process: {error}"))
    };

    Ok(TestStopRequest::Requested {
        run_id: running.run_id,
        process_error,
    })
}

pub(super) fn finalize_test_stop(state: &SharedAppState, run_id: &str) -> Result<(), String> {
    let mut app_state = state.lock().map_err(|_| READ_STATE_ERROR.to_string())?;

    // A newer reservation owns the visible state. The old stop may finish, but
    // it must not overwrite that newer run.
    if app_state.latest_run_id.as_deref() != Some(run_id) {
        return Ok(());
    }

    if app_state.test_is_busy() {
        return Err(WAIT_FOR_STOP_TIMEOUT_ERROR.to_string());
    }

    // The request was accepted while this run was active. If the child had
    // already exited, completion may win the state update before this waiter;
    // the accepted stop still owns the final state.
    app_state.test_status = TestStatus::Stopped;
    app_state.latest_finish_reason = Some(STOPPED_FINISH_REASON.to_string());
    app_state.latest_error_message = None;
    app_state.latest_result_source = None;
    app_state.latest_summary_issue = None;
    Ok(())
}

pub(super) fn wait_for_test_stop(state: &SharedAppState, run_id: &str) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);

    loop {
        let stopped = {
            let app_state = state.lock().map_err(|_| READ_STATE_ERROR.to_string())?;
            app_state
                .active_test
                .as_ref()
                .is_none_or(|active| active.run_id != run_id)
        };

        if stopped {
            return Ok(());
        }

        if Instant::now() >= deadline {
            return Err(WAIT_FOR_STOP_TIMEOUT_ERROR.to_string());
        }

        thread::sleep(Duration::from_millis(25));
    }
}

fn not_ready(message: &str) -> ValidateTestConfigurationResponse {
    ValidateTestConfigurationResponse {
        ready: false,
        message: Some(message.to_string()),
    }
}
