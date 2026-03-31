#![allow(dead_code)]

use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::importing::RuntimeCollection;
use crate::models::{LiveMetrics, TestResult, TestStatus};

#[derive(Clone)]
pub struct RunningTest {
    pub child: Arc<Mutex<Child>>,
    pub script_path: PathBuf,
    pub summary_path: PathBuf,
    pub stop_requested: Arc<AtomicBool>,
}

pub struct AppState {
    pub collection_name: Option<String>,
    pub generated_script: Option<String>,
    pub runtime_collection: Option<RuntimeCollection>,
    pub latest_metrics: Option<LiveMetrics>,
    pub latest_result: Option<TestResult>,
    pub latest_finish_reason: Option<String>,
    pub latest_error_message: Option<String>,
    pub latest_output: String,
    pub test_status: TestStatus,
    pub report_path: Option<PathBuf>,
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
        self.latest_finish_reason = None;
        self.latest_error_message = None;
        self.latest_output.clear();
        self.report_path = None;
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            collection_name: None,
            generated_script: None,
            runtime_collection: None,
            latest_metrics: None,
            latest_result: None,
            latest_finish_reason: None,
            latest_error_message: None,
            latest_output: String::new(),
            test_status: TestStatus::Idle,
            report_path: None,
            launch_in_progress: false,
            active_test: None,
        }
    }
}

pub type SharedAppState = Arc<Mutex<AppState>>;
