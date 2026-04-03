use std::collections::BTreeMap;

use crate::importing::{RuntimeCollection, RuntimeRequest};
use crate::models::{
    K6Options, RampUpStrategy, TestMetrics, TestResult, TestResultStatus, ThresholdConfig,
    TrafficMode,
};

pub(crate) fn test_k6_options(base_url: Option<&str>) -> K6Options {
    K6Options {
        vus: 1,
        duration: "1s".to_string(),
        ramp_up: RampUpStrategy::Instant,
        ramp_up_time: Some("1s".to_string()),
        thresholds: ThresholdConfig {
            p95_response_time: None,
            error_rate: None,
        },
        auth_token: None,
        base_url: base_url.map(ToOwned::to_owned),
        variable_overrides: Default::default(),
        advanced_options_json: None,
        selected_request_ids: (0..64).map(|index| format!("request-{index}")).collect(),
        traffic_mode: TrafficMode::Sequential,
        request_weights: Default::default(),
    }
}

pub(crate) fn empty_runtime_collection() -> RuntimeCollection {
    runtime_collection(Vec::new())
}

pub(crate) fn runtime_collection(requests: Vec<RuntimeRequest>) -> RuntimeCollection {
    RuntimeCollection {
        variables: Default::default(),
        requests: requests
            .into_iter()
            .enumerate()
            .map(|(index, mut request)| {
                request.id = format!("request-{index}");
                request
            })
            .collect(),
    }
}

pub(crate) fn runtime_request(name: &str, url: &str) -> RuntimeRequest {
    RuntimeRequest {
        id: String::new(),
        name: name.to_string(),
        method: "GET".to_string(),
        url: url.to_string(),
        folder_path: Vec::new(),
        headers: Default::default(),
        body: None,
    }
}

pub(crate) fn runtime_request_with_headers(
    name: &str,
    url: &str,
    headers: BTreeMap<String, String>,
) -> RuntimeRequest {
    RuntimeRequest {
        headers,
        ..runtime_request(name, url)
    }
}

pub(crate) fn passed_result() -> TestResult {
    TestResult {
        status: TestResultStatus::Passed,
        metrics: TestMetrics {
            total_requests: 12,
            failed_requests: 0,
            avg_response_time: 50,
            p50_response_time: 40,
            p95_response_time: 80,
            max_response_time: 100,
            requests_per_second: 4.0,
        },
        thresholds: Vec::new(),
    }
}
