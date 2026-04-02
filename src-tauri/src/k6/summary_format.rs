use serde_json::{Map, Value};

pub(crate) type SummaryMetricsMap = Map<String, Value>;

pub(crate) fn normalized_summary_metrics(summary: &Value) -> Option<SummaryMetricsMap> {
    match summary {
        Value::Object(object) => {
            if let Some(metrics) = object.get("metrics").and_then(normalize_metrics_value) {
                return Some(metrics);
            }

            if let Some(metrics) = object
                .get("results")
                .and_then(|results| results.get("metrics"))
                .and_then(normalize_metrics_value)
            {
                return Some(metrics);
            }

            if looks_like_metrics_map(object) {
                return Some(normalize_metrics_object(object));
            }

            object.values().find_map(normalized_summary_metrics)
        }
        Value::Array(values) => values.iter().find_map(normalized_summary_metrics),
        _ => None,
    }
}

pub(crate) fn summary_duration_seconds(summary: &Value) -> Option<f64> {
    match summary {
        Value::Object(object) => object
            .get("config")
            .and_then(|config| config.get("duration"))
            .and_then(Value::as_f64)
            .filter(|value| *value > 0.0)
            .or_else(|| object.values().find_map(summary_duration_seconds)),
        Value::Array(values) => values.iter().find_map(summary_duration_seconds),
        _ => None,
    }
}

fn normalize_metrics_value(metrics: &Value) -> Option<SummaryMetricsMap> {
    metrics
        .as_object()
        .map(normalize_metrics_object)
        .or_else(|| {
            metrics
                .as_array()
                .map(|values| normalize_metrics_array(values))
        })
}

fn normalize_metrics_object(metrics: &SummaryMetricsMap) -> SummaryMetricsMap {
    let mut normalized = SummaryMetricsMap::new();

    for (name, metric) in metrics {
        let Some(metric_object) = metric.as_object() else {
            continue;
        };

        let mut normalized_metric = metric_object.clone();
        normalize_metric_percentiles(&mut normalized_metric);
        normalized.insert(name.clone(), Value::Object(normalized_metric));
    }

    normalized
}

fn normalize_metrics_array(metrics: &[Value]) -> SummaryMetricsMap {
    let mut normalized = SummaryMetricsMap::new();

    for metric in metrics {
        let Some(name) = metric.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(metric_object) = metric.as_object() else {
            continue;
        };

        let mut normalized_metric = metric_object.clone();
        normalized_metric.remove("name");
        normalize_metric_percentiles(&mut normalized_metric);
        normalized.insert(name.to_string(), Value::Object(normalized_metric));
    }

    normalized
}

fn normalize_metric_percentiles(metric: &mut SummaryMetricsMap) {
    if let Some(values) = metric.get_mut("values").and_then(Value::as_object_mut) {
        copy_percentile_alias(values, "p50", "p(50)");
        copy_percentile_alias(values, "p90", "p(90)");
        copy_percentile_alias(values, "p95", "p(95)");
        copy_percentile_alias(values, "p99", "p(99)");
    }
}

fn copy_percentile_alias(values: &mut SummaryMetricsMap, source: &str, target: &str) {
    let Some(value) = values.get(source).cloned() else {
        return;
    };

    values.entry(target.to_string()).or_insert(value);
}

fn looks_like_metrics_map(metrics: &SummaryMetricsMap) -> bool {
    ["http_reqs", "http_req_duration", "http_req_failed", "vus"]
        .iter()
        .any(|metric_name| matches!(metrics.get(*metric_name), Some(Value::Object(_))))
}
