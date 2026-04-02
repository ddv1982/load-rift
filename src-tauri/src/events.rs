use tauri::{AppHandle, Emitter};

use crate::models::{LiveMetrics, TestCompletion};

pub const K6_OUTPUT_EVENT: &str = "k6:output";
pub const K6_METRICS_EVENT: &str = "k6:metrics";
pub const K6_COMPLETE_EVENT: &str = "k6:complete";
pub const K6_ERROR_EVENT: &str = "k6:error";
pub const MAIN_WINDOW_LABEL: &str = "main";

pub fn emit_k6_output(app: &AppHandle, payload: &str) -> tauri::Result<()> {
    app.emit_to(MAIN_WINDOW_LABEL, K6_OUTPUT_EVENT, payload.to_string())
}

pub fn emit_k6_metrics(app: &AppHandle, payload: LiveMetrics) -> tauri::Result<()> {
    app.emit_to(MAIN_WINDOW_LABEL, K6_METRICS_EVENT, payload)
}

pub fn emit_k6_complete(app: &AppHandle, payload: TestCompletion) -> tauri::Result<()> {
    app.emit_to(MAIN_WINDOW_LABEL, K6_COMPLETE_EVENT, payload)
}

pub fn emit_k6_error(app: &AppHandle, payload: &str) -> tauri::Result<()> {
    app.emit_to(MAIN_WINDOW_LABEL, K6_ERROR_EVENT, payload.to_string())
}
