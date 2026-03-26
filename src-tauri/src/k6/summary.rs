use serde_json::Value;

use crate::models::{LiveMetrics, TestMetrics, TestResult, TestResultStatus, ThresholdResult};

const K6_THRESHOLD_FAILURE_EXIT_CODE: i32 = 99;

pub(crate) fn parse_summary(
    summary_json: &str,
    configured_vus: u32,
) -> Result<(TestResult, LiveMetrics), String> {
    let summary: Value = serde_json::from_str(summary_json)
        .map_err(|error| format!("Failed to parse the k6 summary output: {error}"))?;
    let metrics = summary
        .get("metrics")
        .and_then(Value::as_object)
        .ok_or("The k6 summary did not contain a metrics object.".to_string())?;

    let total_requests = metric_value(metrics, "http_reqs", &["count"]);
    let error_rate = metric_value(metrics, "http_req_failed", &["rate", "value"]);
    let failed_requests = (total_requests * error_rate).round();
    let avg_response_time = metric_value(metrics, "http_req_duration", &["avg"]);
    let p50_response_time = metric_value(metrics, "http_req_duration", &["med", "p(50)"]);
    let p95_response_time = metric_value(metrics, "http_req_duration", &["p(95)"]);
    let max_response_time = metric_value(metrics, "http_req_duration", &["max"]);
    let requests_per_second = metric_value(metrics, "http_reqs", &["rate"]);

    let thresholds = collect_thresholds(metrics);
    let status = if thresholds.iter().any(|threshold| !threshold.passed) {
        TestResultStatus::Failed
    } else if failed_requests > 0.0 {
        TestResultStatus::Warning
    } else {
        TestResultStatus::Passed
    };

    Ok((
        TestResult {
            status,
            metrics: TestMetrics {
                total_requests: total_requests.max(0.0).round() as u64,
                failed_requests: failed_requests.max(0.0).round() as u64,
                avg_response_time: avg_response_time.max(0.0).round() as u64,
                p50_response_time: p50_response_time.max(0.0).round() as u64,
                p95_response_time: p95_response_time.max(0.0).round() as u64,
                max_response_time: max_response_time.max(0.0).round() as u64,
                requests_per_second,
            },
            thresholds: thresholds.clone(),
        },
        LiveMetrics {
            active_vus: if total_requests > 0.0 || configured_vus > 0 {
                0
            } else {
                metric_value(metrics, "vus", &["value"]).round() as u32
            },
            total_requests: total_requests.max(0.0).round() as u64,
            failed_requests: failed_requests.max(0.0).round() as u64,
            error_rate,
            p50_response_time: p50_response_time.max(0.0).round() as u64,
            p95_response_time: p95_response_time.max(0.0).round() as u64,
            requests_per_second,
        },
    ))
}

pub(crate) fn is_threshold_failure_exit(exit_code: Option<i32>, result: &TestResult) -> bool {
    exit_code == Some(K6_THRESHOLD_FAILURE_EXIT_CODE)
        && matches!(result.status, TestResultStatus::Failed)
}

fn metric_value(
    metrics: &serde_json::Map<String, Value>,
    metric_name: &str,
    value_names: &[&str],
) -> f64 {
    metrics
        .get(metric_name)
        .map(|metric| metric_field_value(metric, value_names))
        .unwrap_or(0.0)
}

fn metric_field_value(metric: &Value, value_names: &[&str]) -> f64 {
    for value_name in value_names {
        if let Some(value) = metric
            .get("values")
            .and_then(|values| values.get(value_name))
            .and_then(Value::as_f64)
            .or_else(|| metric.get(value_name).and_then(Value::as_f64))
        {
            return value;
        }
    }

    0.0
}

fn collect_thresholds(metrics: &serde_json::Map<String, Value>) -> Vec<ThresholdResult> {
    let mut thresholds = Vec::new();

    for (metric_name, metric) in metrics {
        let Some(threshold_map) = metric.get("thresholds").and_then(Value::as_object) else {
            continue;
        };

        for (threshold_name, passed) in threshold_map {
            thresholds.push(ThresholdResult {
                name: format!("{metric_name}: {threshold_name}"),
                passed: threshold_passed(passed),
                actual: threshold_actual(metric_name, metric, threshold_name),
                threshold: parse_threshold_value(threshold_name),
            });
        }
    }

    thresholds
}

fn threshold_passed(threshold: &Value) -> bool {
    threshold
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| !threshold.as_bool().unwrap_or(false))
}

fn threshold_actual(metric_name: &str, metric: &Value, threshold_name: &str) -> f64 {
    let value_names = if threshold_name.contains("p(95)") {
        &["p(95)"][..]
    } else if threshold_name.contains("rate") {
        &["rate", "value"][..]
    } else {
        &["value"][..]
    };

    let actual = metric_field_value(metric, value_names);
    if actual > 0.0 {
        actual
    } else {
        metric_value_from_metric_name(metric_name, metric)
    }
}

fn metric_value_from_metric_name(metric_name: &str, metric: &Value) -> f64 {
    let fallback = match metric_name {
        "http_req_duration" => &["avg"][..],
        "http_req_failed" => &["rate", "value"][..],
        _ => &["value"][..],
    };
    metric_field_value(metric, fallback)
}

fn parse_threshold_value(threshold_name: &str) -> f64 {
    threshold_name
        .chars()
        .filter(|character| character.is_ascii_digit() || *character == '.')
        .collect::<String>()
        .parse::<f64>()
        .unwrap_or(0.0)
}
