use std::thread;
use std::time::{Duration, Instant};

use crate::importing::{validate_test_run, RuntimeCollection};
use crate::k6::{analyze_advanced_options_json, validate_advanced_options_json};
use crate::models::{
    GetTestStatusResponse, K6Options, TestStatus, TrafficMode, ValidateTestConfigurationResponse,
};
use crate::state::SharedAppState;

const READ_STATE_ERROR: &str = "Failed to read the shared Tauri app state.";
const RUNNER_BUSY_START_ERROR: &str =
    "A k6 test is already running or still shutting down. Wait a moment and try again.";
const RUNNER_BUSY_VALIDATE_ERROR: &str =
    "A k6 test is already running or still shutting down. Wait a moment before starting another run.";
const IMPORT_BEFORE_START_ERROR: &str = "Import a Postman collection before starting a k6 test.";
const IMPORT_BEFORE_VALIDATE_ERROR: &str =
    "Import a Postman collection before validating the k6 settings.";
const IMPORT_BEFORE_SMOKE_TEST_ERROR: &str =
    "Import a Postman collection before running a smoke test.";
const RUNNER_BUSY_SMOKE_TEST_ERROR: &str =
    "A k6 test is already running or still shutting down. Wait a moment before running a smoke test.";
const CANCELLED_START_ERROR: &str = "The pending k6 test start was cancelled before launch.";
const WAIT_FOR_STOP_TIMEOUT_ERROR: &str =
    "Timed out while waiting for the active k6 test to shut down.";
const READY_TO_RUN_MESSAGE: &str = "Configuration looks ready to run.";
const BASE_URL_GUIDANCE: &str =
    "Apply a Postman cURL snippet to derive the base URL required by this collection.";
const ADVANCED_SCENARIOS_OVERRIDE_TRAFFIC_MODE_MESSAGE: &str =
    "Configuration looks ready to run. Advanced k6 scenarios override the built-in weighted mix settings. Use advanced scenarios/executors for stricter fixed traffic ratios.";
const WEIGHTED_MODE_READY_MESSAGE: &str =
    "Configuration looks ready to run. Weighted mix prefers generated per-request scenarios when VU capacity allows, otherwise deterministic weighted scheduling per iteration.";

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
        status,
        is_running,
        metrics: state.latest_metrics.clone(),
        result: state.latest_result.clone(),
        finish_reason: state.latest_finish_reason.clone(),
        error_message: state.latest_error_message.clone(),
    })
}

pub(super) fn begin_test_start_validation(
    state: &SharedAppState,
) -> Result<(String, RuntimeCollection), String> {
    let mut app_state = state.lock().map_err(|_| READ_STATE_ERROR.to_string())?;

    if app_state.test_is_busy() {
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

    app_state.launch_in_progress = true;
    app_state.test_status = TestStatus::Idle;

    Ok((script, runtime_collection))
}

pub(super) fn finalize_test_start_reservation(
    state: &SharedAppState,
    script: &str,
) -> Result<String, String> {
    let mut app_state = state.lock().map_err(|_| READ_STATE_ERROR.to_string())?;

    if app_state.active_test.is_some() {
        return Err(RUNNER_BUSY_START_ERROR.to_string());
    }

    if !app_state.launch_in_progress {
        return Err(CANCELLED_START_ERROR.to_string());
    }

    app_state.clear_test_run_state();
    app_state.test_status = TestStatus::Idle;

    Ok(script.to_string())
}

pub(super) fn release_failed_start(state: &SharedAppState) {
    if let Ok(mut app_state) = state.lock() {
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

pub(super) fn runtime_collection_for_smoke_test(
    state: &SharedAppState,
) -> Result<RuntimeCollection, String> {
    let app_state = state.lock().map_err(|_| READ_STATE_ERROR.to_string())?;

    if app_state.test_is_busy() {
        return Err(RUNNER_BUSY_SMOKE_TEST_ERROR.to_string());
    }

    app_state
        .runtime_collection
        .clone()
        .ok_or(IMPORT_BEFORE_SMOKE_TEST_ERROR.to_string())
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

pub(super) fn wait_for_test_stop(state: &SharedAppState) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);

    loop {
        let stopped = {
            let app_state = state.lock().map_err(|_| READ_STATE_ERROR.to_string())?;
            app_state.active_test.is_none()
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
