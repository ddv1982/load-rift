use crate::events::emit_k6_error;
use crate::models::{LiveMetrics, TestStatus};
use crate::state::{AppState, RunningTest, SharedAppState};

use super::super::summary::is_threshold_failure_exit;

pub(crate) const UPDATE_STATE_ERROR: &str = "Failed to update the shared Tauri app state.";
const FINISH_REASON_STOPPED: &str = "stopped";
const FINISH_REASON_COMPLETED: &str = "completed";
const FINISH_REASON_THRESHOLDS_FAILED: &str = "thresholds_failed";
const FINISH_REASON_EXECUTION_ERROR: &str = "execution_error";

pub(crate) fn record_failure(state: &SharedAppState, app: &tauri::AppHandle, message: &str) {
    if let Ok(mut app_state) = state.lock() {
        clear_active_run(&mut app_state);
        app_state.test_status = TestStatus::Failed;
        app_state.latest_finish_reason = Some(FINISH_REASON_EXECUTION_ERROR.to_string());
        app_state.latest_error_message = Some(message.to_string());
    }

    let _ = emit_k6_error(app, message);
}

pub(crate) fn store_started_state(
    state: &SharedAppState,
    initial_metrics: LiveMetrics,
    running_test: RunningTest,
) -> Result<(), String> {
    let mut app_state = state.lock().map_err(|_| UPDATE_STATE_ERROR.to_string())?;
    app_state.clear_test_run_state();
    app_state.latest_metrics = Some(initial_metrics);
    app_state.launch_in_progress = false;
    app_state.test_status = TestStatus::Running;
    app_state.active_test = Some(running_test);
    Ok(())
}

pub(crate) fn mark_stopped(state: &SharedAppState) {
    if let Ok(mut app_state) = state.lock() {
        clear_active_run(&mut app_state);
        app_state.test_status = TestStatus::Stopped;
        app_state.latest_finish_reason = Some(FINISH_REASON_STOPPED.to_string());
        app_state.latest_error_message = None;
    }
}

pub(crate) fn store_completion(
    state: &SharedAppState,
    metrics: &LiveMetrics,
    result: &crate::models::TestResult,
    run_state: TestStatus,
    finish_reason: &str,
    summary_json: Option<String>,
) {
    if let Ok(mut app_state) = state.lock() {
        app_state.latest_metrics = Some(metrics.clone());
        app_state.latest_result = Some(result.clone());
        app_state.latest_summary_json = summary_json;
        app_state.latest_finish_reason = Some(finish_reason.to_string());
        app_state.latest_error_message = None;
        clear_active_run(&mut app_state);
        app_state.test_status = run_state;
    }
}

fn clear_active_run(app_state: &mut AppState) {
    app_state.launch_in_progress = false;
    app_state.active_test = None;
    if let Some(metrics) = app_state.latest_metrics.as_mut() {
        metrics.active_vus = 0;
    }
}

pub(crate) fn completion_status(
    exited_successfully: bool,
    exit_code: Option<i32>,
    result: &crate::models::TestResult,
) -> CompletionState {
    let threshold_failure_exit = is_threshold_failure_exit(exit_code, result);
    let completed_run = exited_successfully || threshold_failure_exit;
    let run_state = if completed_run {
        TestStatus::Completed
    } else {
        TestStatus::Failed
    };
    let finish_reason = if exited_successfully {
        FINISH_REASON_COMPLETED
    } else if threshold_failure_exit {
        FINISH_REASON_THRESHOLDS_FAILED
    } else {
        FINISH_REASON_EXECUTION_ERROR
    };

    CompletionState {
        run_state,
        finish_reason: finish_reason.to_string(),
        threshold_failure_exit,
    }
}

pub(crate) struct CompletionState {
    pub(crate) run_state: TestStatus,
    pub(crate) finish_reason: String,
    pub(crate) threshold_failure_exit: bool,
}
