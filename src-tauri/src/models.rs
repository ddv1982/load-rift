use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThresholdConfig {
    pub p95_response_time: Option<u32>,
    pub error_rate: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RampUpStrategy {
    Instant,
    Gradual,
    Staged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct K6Options {
    pub vus: u32,
    pub duration: String,
    pub ramp_up: RampUpStrategy,
    pub ramp_up_time: Option<String>,
    pub thresholds: ThresholdConfig,
    pub auth_token: Option<String>,
    pub base_url: Option<String>,
    #[serde(default)]
    pub variable_overrides: BTreeMap<String, String>,
    pub advanced_options_json: Option<String>,
    #[serde(default)]
    pub selected_request_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeVariable {
    pub key: String,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestInfo {
    pub id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub folder_path: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInfo {
    pub name: String,
    pub request_count: usize,
    pub folder_count: usize,
    pub requests: Vec<RequestInfo>,
    pub runtime_variables: Vec<RuntimeVariable>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMetrics {
    pub active_vus: u32,
    pub total_requests: u64,
    pub failed_requests: u64,
    pub error_rate: f64,
    pub avg_response_time: u64,
    pub p50_response_time: u64,
    pub p95_response_time: u64,
    pub max_response_time: u64,
    pub requests_per_second: f64,
}

impl Default for LiveMetrics {
    fn default() -> Self {
        Self {
            active_vus: 0,
            total_requests: 0,
            failed_requests: 0,
            error_rate: 0.0,
            avg_response_time: 0,
            p50_response_time: 0,
            p95_response_time: 0,
            max_response_time: 0,
            requests_per_second: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThresholdResult {
    pub name: String,
    pub passed: bool,
    pub actual: f64,
    pub threshold: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TestResultStatus {
    Passed,
    Warning,
    Failed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TestStatus {
    #[default]
    Idle,
    Running,
    Completed,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestMetrics {
    pub total_requests: u64,
    pub failed_requests: u64,
    pub avg_response_time: u64,
    pub p50_response_time: u64,
    pub p95_response_time: u64,
    pub max_response_time: u64,
    pub requests_per_second: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub status: TestResultStatus,
    pub metrics: TestMetrics,
    pub thresholds: Vec<ThresholdResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCompletion {
    pub run_state: TestStatus,
    pub finish_reason: String,
    pub metrics: LiveMetrics,
    pub result: TestResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetTestStatusResponse {
    pub status: TestStatus,
    pub is_running: bool,
    pub metrics: Option<LiveMetrics>,
    pub result: Option<TestResult>,
    pub finish_reason: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateTestConfigurationResponse {
    pub ready: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeTestResponse {
    pub responses: Vec<SmokeTestResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeTestResult {
    pub request_id: String,
    pub request_name: String,
    pub method: String,
    pub url: String,
    pub status_code: Option<u16>,
    pub duration_ms: u64,
    pub ok: bool,
    pub content_type: Option<String>,
    pub response_headers: BTreeMap<String, String>,
    pub body_preview: Option<String>,
    pub error_message: Option<String>,
}
