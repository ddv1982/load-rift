use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::importing::RuntimeCollection;
use crate::models::{LiveMetrics, TestResult, TestResultSource, TestStatus};

const MAX_LATEST_OUTPUT_BYTES: usize = 256 * 1024;
const OUTPUT_TRUNCATION_NOTICE: &str =
    "[Load Rift truncated earlier k6 output to keep the app responsive.]\n";

#[derive(Clone)]
pub struct RunningTest {
    pub run_id: String,
    pub child: Arc<Mutex<Child>>,
    pub stop_requested: Arc<AtomicBool>,
}

pub struct AppState {
    pub generated_script: Option<String>,
    pub runtime_collection: Option<RuntimeCollection>,
    pub latest_metrics: Option<LiveMetrics>,
    pub latest_result: Option<TestResult>,
    pub latest_summary_json: Option<String>,
    pub latest_finish_reason: Option<String>,
    pub latest_error_message: Option<String>,
    pub latest_result_source: Option<TestResultSource>,
    pub latest_summary_issue: Option<String>,
    pub latest_output: String,
    pub latest_run_id: Option<String>,
    pub test_status: TestStatus,
    pub launch_in_progress: bool,
    pub active_test: Option<RunningTest>,
}

impl AppState {
    pub fn test_is_busy(&self) -> bool {
        self.launch_in_progress || self.active_test.is_some()
    }

    pub fn clear_test_run_state(&mut self) {
        self.latest_metrics = None;
        self.latest_result = None;
        self.latest_summary_json = None;
        self.latest_finish_reason = None;
        self.latest_error_message = None;
        self.latest_result_source = None;
        self.latest_summary_issue = None;
        self.latest_output.clear();
    }

    pub fn append_latest_output(&mut self, output: &str) {
        self.latest_output.push_str(output);
        truncate_to_latest_output_tail(&mut self.latest_output);
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            generated_script: None,
            runtime_collection: None,
            latest_metrics: None,
            latest_result: None,
            latest_summary_json: None,
            latest_finish_reason: None,
            latest_error_message: None,
            latest_result_source: None,
            latest_summary_issue: None,
            latest_output: String::new(),
            latest_run_id: None,
            test_status: TestStatus::Idle,
            launch_in_progress: false,
            active_test: None,
        }
    }
}

pub type SharedAppState = Arc<Mutex<AppState>>;

fn truncate_to_latest_output_tail(output: &mut String) {
    if output.len() <= MAX_LATEST_OUTPUT_BYTES {
        return;
    }

    let retain_budget = MAX_LATEST_OUTPUT_BYTES.saturating_sub(OUTPUT_TRUNCATION_NOTICE.len());
    let mut retain_start = output.len().saturating_sub(retain_budget);
    while retain_start < output.len() && !output.is_char_boundary(retain_start) {
        retain_start += 1;
    }

    output.replace_range(..retain_start, OUTPUT_TRUNCATION_NOTICE);
}

#[cfg(test)]
mod tests {
    use super::{AppState, MAX_LATEST_OUTPUT_BYTES, OUTPUT_TRUNCATION_NOTICE};

    #[test]
    fn append_latest_output_keeps_recent_tail_when_large() {
        let mut state = AppState::default();
        state.append_latest_output(&"a".repeat(MAX_LATEST_OUTPUT_BYTES));
        state.append_latest_output("tail");

        assert!(state.latest_output.len() <= MAX_LATEST_OUTPUT_BYTES);
        assert!(state.latest_output.starts_with(OUTPUT_TRUNCATION_NOTICE));
        assert!(state.latest_output.ends_with("tail"));
    }

    #[test]
    fn append_latest_output_preserves_utf8_boundaries() {
        let mut state = AppState::default();
        state.append_latest_output(&"🙂".repeat(MAX_LATEST_OUTPUT_BYTES / 4));
        state.append_latest_output("done");

        assert!(state
            .latest_output
            .is_char_boundary(state.latest_output.len()));
        assert!(state.latest_output.ends_with("done"));
    }
}
