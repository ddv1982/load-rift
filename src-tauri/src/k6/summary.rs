use serde_json::Value;

use crate::models::{LiveMetrics, TestMetrics, TestResult, TestResultStatus, ThresholdResult};

use super::summary_format::{
    normalized_summary_metrics, summary_duration_seconds, SummaryMetricsMap,
};

const K6_THRESHOLD_FAILURE_EXIT_CODE: i32 = 99;

pub(crate) fn parse_summary(
    summary_json: &str,
    configured_vus: u32,
) -> Result<(TestResult, LiveMetrics), String> {
    let summary: Value = serde_json::from_str(summary_json)
        .map_err(|error| format!("Failed to parse the k6 summary output: {error}"))?;
    let metrics = normalized_summary_metrics(&summary)
        .ok_or("The k6 summary did not contain a supported metrics payload.".to_string())?;

    let total_requests = metric_value(&metrics, "http_reqs", &["count"]);
    let error_rate = error_rate(&metrics);
    let failed_requests = failed_requests(&metrics, total_requests, error_rate);
    let avg_response_time = metric_value(&metrics, "http_req_duration", &["avg"]);
    let p50_response_time = metric_value(&metrics, "http_req_duration", &["med", "p(50)", "p50"]);
    let p95_response_time = metric_value(&metrics, "http_req_duration", &["p(95)", "p95"]);
    let max_response_time = metric_value(&metrics, "http_req_duration", &["max"]);
    let requests_per_second = requests_per_second(&summary, &metrics, total_requests);

    let thresholds = collect_thresholds(&metrics);
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
                metric_value(&metrics, "vus", &["value"]).round() as u32
            },
            total_requests: total_requests.max(0.0).round() as u64,
            failed_requests: failed_requests.max(0.0).round() as u64,
            error_rate,
            avg_response_time: avg_response_time.max(0.0).round() as u64,
            p50_response_time: p50_response_time.max(0.0).round() as u64,
            p95_response_time: p95_response_time.max(0.0).round() as u64,
            max_response_time: max_response_time.max(0.0).round() as u64,
            requests_per_second,
        },
    ))
}

pub(crate) fn result_from_live_metrics(
    metrics: &LiveMetrics,
    exit_code: Option<i32>,
) -> TestResult {
    let status = if exit_code == Some(K6_THRESHOLD_FAILURE_EXIT_CODE) {
        TestResultStatus::Failed
    } else if metrics.failed_requests > 0 {
        TestResultStatus::Warning
    } else {
        TestResultStatus::Passed
    };

    TestResult {
        status,
        metrics: TestMetrics {
            total_requests: metrics.total_requests,
            failed_requests: metrics.failed_requests,
            avg_response_time: metrics.avg_response_time,
            p50_response_time: metrics.p50_response_time,
            p95_response_time: metrics.p95_response_time,
            max_response_time: metrics.max_response_time,
            requests_per_second: metrics.requests_per_second,
        },
        thresholds: Vec::new(),
    }
}

pub(crate) fn summary_metrics_map(summary: &Value) -> Option<SummaryMetricsMap> {
    normalized_summary_metrics(summary)
}

pub(crate) fn is_threshold_failure_exit(exit_code: Option<i32>, result: &TestResult) -> bool {
    exit_code == Some(K6_THRESHOLD_FAILURE_EXIT_CODE)
        && matches!(result.status, TestResultStatus::Failed)
}

fn metric_value(metrics: &SummaryMetricsMap, metric_name: &str, value_names: &[&str]) -> f64 {
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
            .or_else(|| {
                metric
                    .get("values")
                    .and_then(|values| values.get(normalized_percentile_name(value_name)))
                    .and_then(Value::as_f64)
            })
            .or_else(|| metric.get(value_name).and_then(Value::as_f64))
            .or_else(|| {
                metric
                    .get(normalized_percentile_name(value_name))
                    .and_then(Value::as_f64)
            })
        {
            return value;
        }
    }

    0.0
}

fn error_rate(metrics: &SummaryMetricsMap) -> f64 {
    let rate = metric_value(metrics, "http_req_failed", &["rate", "value"]);
    if rate > 0.0 {
        return rate;
    }

    let total = metric_value(metrics, "http_req_failed", &["total"]);
    let matches = metric_value(metrics, "http_req_failed", &["matches"]);
    if total > 0.0 {
        return matches / total;
    }

    0.0
}

fn failed_requests(metrics: &SummaryMetricsMap, total_requests: f64, error_rate: f64) -> f64 {
    let matches = metric_value(metrics, "http_req_failed", &["matches"]);
    if matches > 0.0 {
        return matches.round();
    }

    (total_requests * error_rate).round()
}

fn requests_per_second(summary: &Value, metrics: &SummaryMetricsMap, total_requests: f64) -> f64 {
    let rate = metric_value(metrics, "http_reqs", &["rate"]);
    if rate > 0.0 {
        return rate;
    }

    let Some(duration_seconds) = summary_duration_seconds(summary) else {
        return 0.0;
    };

    total_requests / duration_seconds
}

fn collect_thresholds(metrics: &SummaryMetricsMap) -> Vec<ThresholdResult> {
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
        &["p(95)", "p95"][..]
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

fn normalized_percentile_name(value_name: &str) -> &str {
    match value_name {
        "p(50)" => "p50",
        "p(90)" => "p90",
        "p(95)" => "p95",
        "p(99)" => "p99",
        _ => value_name,
    }
}
