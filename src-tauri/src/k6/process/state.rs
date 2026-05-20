use crate::models::{LiveMetrics, TestResult, TestResultSource, TestStatus};
use crate::state::{AppState, RunningTest, SharedAppState};

use super::super::summary::is_threshold_failure_exit;

pub(crate) const UPDATE_STATE_ERROR: &str = "Failed to update the shared Tauri app state.";
const FINISH_REASON_STOPPED: &str = "stopped";
const FINISH_REASON_COMPLETED: &str = "completed";
const FINISH_REASON_THRESHOLDS_FAILED: &str = "thresholds_failed";
const FINISH_REASON_EXECUTION_ERROR: &str = "execution_error";

pub(crate) fn store_started_state(
    state: &SharedAppState,
    initial_metrics: LiveMetrics,
    running_test: RunningTest,
) -> Result<(), String> {
    let mut app_state = state.lock().map_err(|_| UPDATE_STATE_ERROR.to_string())?;
    app_state.clear_test_run_state();
    app_state.latest_run_id = Some(running_test.run_id.clone());
    app_state.latest_metrics = Some(initial_metrics);
    app_state.launch_in_progress = false;
    app_state.test_status = TestStatus::Running;
    app_state.active_test = Some(running_test);
    Ok(())
}

pub(crate) fn mark_stopped(state: &SharedAppState, run_id: &str) -> bool {
    if let Ok(mut app_state) = state.lock() {
        if !is_current_run(&app_state, run_id) {
            return false;
        }

        clear_active_run(&mut app_state);
        app_state.test_status = TestStatus::Stopped;
        app_state.latest_finish_reason = Some(FINISH_REASON_STOPPED.to_string());
        app_state.latest_error_message = None;
        app_state.latest_result_source = None;
        app_state.latest_summary_issue = None;
        return true;
    }

    false
}

pub(crate) struct CompletionRecord {
    pub(crate) metrics: LiveMetrics,
    pub(crate) result: TestResult,
    pub(crate) run_state: TestStatus,
    pub(crate) finish_reason: String,
    pub(crate) summary_json: Option<String>,
    pub(crate) result_source: TestResultSource,
    pub(crate) summary_issue: Option<String>,
    pub(crate) error_message: Option<String>,
}

pub(crate) fn store_completion(
    state: &SharedAppState,
    run_id: &str,
    record: CompletionRecord,
) -> bool {
    if let Ok(mut app_state) = state.lock() {
        if !is_current_run(&app_state, run_id) {
            return false;
        }

        app_state.latest_metrics = Some(record.metrics);
        app_state.latest_result = Some(record.result);
        app_state.latest_summary_json = record.summary_json;
        app_state.latest_finish_reason = Some(record.finish_reason);
        app_state.latest_error_message = record.error_message;
        app_state.latest_result_source = Some(record.result_source);
        app_state.latest_summary_issue = record.summary_issue;
        clear_active_run(&mut app_state);
        app_state.test_status = record.run_state;
        return true;
    }

    false
}

fn is_current_run(app_state: &AppState, run_id: &str) -> bool {
    app_state
        .active_test
        .as_ref()
        .is_some_and(|active| active.run_id == run_id)
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
