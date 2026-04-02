use std::env;
use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value};

use crate::models::{TestResult, ThresholdResult};
use crate::state::SharedAppState;

const REPORT_TITLE: &str = "k6 Detailed Test Report";
const BASE_STYLES: &str = r#"
      :root {
        color-scheme: dark;
        background: #0f1115;
        color: #e6e9ef;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        padding: 24px;
        background: #0f1115;
        font-family: Inter, "IBM Plex Sans", sans-serif;
      }
      main {
        max-width: 1200px;
        margin: 0 auto;
      }
      .panel {
        margin-top: 20px;
        padding: 20px;
        border-radius: 16px;
        border: 1px solid #262c36;
        background: #151922;
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.2);
      }
      header.panel {
        margin-top: 0;
      }
      h1, h2, h3 {
        margin: 0;
      }
      h1 {
        font-size: 26px;
        margin-bottom: 8px;
      }
      h2 {
        font-size: 18px;
        margin-bottom: 14px;
      }
      h3 {
        font-size: 15px;
        margin-bottom: 12px;
        color: #f4efe6;
      }
      p {
        margin: 0;
        color: #9aa3b2;
      }
"#;
const OVERVIEW_STYLES: &str = r#"
      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 999px;
        background: #1d2430;
        color: #f4efe6;
        font-weight: 700;
        text-transform: capitalize;
      }
      .overview-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 12px;
        margin-top: 18px;
      }
      .overview-card {
        padding: 14px 16px;
        border-radius: 14px;
        background: #0f141c;
        border: 1px solid #222a36;
      }
      .overview-card span {
        display: block;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #7c8797;
      }
      .overview-card strong {
        display: block;
        margin-top: 6px;
        font-size: 20px;
        color: #f4efe6;
      }
"#;
const TABLE_STYLES: &str = r#"
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        padding: 10px 12px;
        text-align: left;
        vertical-align: top;
        border-bottom: 1px solid #232a35;
      }
      th {
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: #8b95a4;
      }
      td {
        color: #d9dee7;
      }
"#;
const METRIC_STYLES: &str = r#"
      .metric-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 14px;
      }
      .metric-card {
        padding: 16px;
        border-radius: 14px;
        border: 1px solid #232a35;
        background: #10151d;
      }
      .metric-meta {
        font-size: 12px;
        color: #8b95a4;
        margin-bottom: 12px;
      }
      .chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .metric-chip {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        padding: 5px 10px;
        border-radius: 999px;
        background: #1c2330;
        color: #d9dee7;
        font-size: 12px;
      }
      .metric-chip strong {
        color: #f4efe6;
      }
      .threshold-pass {
        color: #66d9a6;
        font-weight: 700;
      }
      .threshold-fail {
        color: #ff8f8f;
        font-weight: 700;
      }
"#;
const DETAIL_STYLES: &str = r#"
      pre {
        margin: 0;
        overflow: auto;
        padding: 20px;
        border-radius: 14px;
        border: 1px solid #262c36;
        background: #0f141c;
        color: #d9dee7;
        font: 13px/1.5 "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        white-space: pre-wrap;
      }
      details summary {
        cursor: pointer;
        color: #c6ceda;
        font-weight: 600;
        margin-bottom: 12px;
      }
"#;
const METRIC_CATEGORY_ORDER: [&str; 4] = ["HTTP", "Execution", "Network", "Checks & Other"];

type SummaryMetricsMap = Map<String, Value>;

pub fn export_report_file(state: &SharedAppState, save_path: &str) -> Result<PathBuf, String> {
    let (result, output, summary_json) = {
        let app_state = state
            .lock()
            .map_err(|_| "Failed to read the shared Tauri app state.".to_string())?;
        (
            app_state.latest_result.clone(),
            app_state.latest_output.clone(),
            app_state.latest_summary_json.clone(),
        )
    };

    let Some(result) = result else {
        return Err("Run a k6 test before exporting a report.".to_string());
    };

    let target_path = normalize_export_path(save_path)?;
    let report = render_report(&result, &output, summary_json.as_deref());
    fs::write(&target_path, report).map_err(|error| {
        format!(
            "Failed to write the report to {}: {error}",
            target_path.display()
        )
    })?;

    Ok(target_path)
}

fn normalize_export_path(save_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(save_path);
    let path = if path.is_absolute() {
        path
    } else {
        env::current_dir()
            .map_err(|error| format!("Failed to resolve the export location: {error}"))?
            .join(path)
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create the export directory {}: {error}",
                parent.display()
            )
        })?;
    }

    Ok(path)
}

pub(crate) fn extract_end_of_test_summary(output: &str) -> &str {
    for marker in [
        "\n  █ THRESHOLDS",
        "\n█ THRESHOLDS",
        "\n  █ TOTAL RESULTS",
        "\n█ TOTAL RESULTS",
    ] {
        if let Some(index) = output.find(marker) {
            return output[index + 1..].trim();
        }
    }

    output.trim()
}

pub(crate) fn render_report(
    result: &TestResult,
    output: &str,
    summary_json: Option<&str>,
) -> String {
    let view = ReportView::new(result, output, summary_json);

    format!(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{title}</title>
    <style>{styles}
    </style>
  </head>
  <body>
    <main>
      {header_section}
      {threshold_section}
      {metrics_section}
      {raw_summary_section}
      {console_summary_section}
    </main>
  </body>
</html>
"#,
        title = REPORT_TITLE,
        styles = report_styles(),
        header_section = view.render_header_section(),
        threshold_section = render_threshold_section(&result.thresholds),
        metrics_section = render_structured_metrics(view.summary_metrics()),
        raw_summary_section = render_raw_summary(view.summary_json),
        console_summary_section = view.render_console_summary_section(),
    )
}

struct ReportView<'a> {
    result: &'a TestResult,
    summary_json: Option<&'a str>,
    summary_output: &'a str,
    parsed_summary: Option<Value>,
}

impl<'a> ReportView<'a> {
    fn new(result: &'a TestResult, output: &'a str, summary_json: Option<&'a str>) -> Self {
        Self {
            result,
            summary_json,
            summary_output: extract_end_of_test_summary(output),
            parsed_summary: parse_summary_json(summary_json),
        }
    }

    fn render_header_section(&self) -> String {
        format!(
            "<header class=\"panel\"><p>Exported from Load Rift using the latest captured k6 summary data.</p><h1>{}</h1><div class=\"status\">{}</div><div class=\"overview-grid\">{}</div></header>",
            REPORT_TITLE,
            escape_html(&format!("{:?}", self.result.status)),
            self.render_overview_cards()
        )
    }

    fn render_console_summary_section(&self) -> String {
        format!(
            "<section class=\"panel\"><h2>Console end-of-test summary</h2><pre>{}</pre></section>",
            escape_html(self.summary_output)
        )
    }

    fn render_overview_cards(&self) -> String {
        [
            ("Total requests", self.result.metrics.total_requests.to_string()),
            ("Failed requests", self.result.metrics.failed_requests.to_string()),
            (
                "Average response",
                format!("{} ms", self.result.metrics.avg_response_time),
            ),
            (
                "P95 response",
                format!("{} ms", self.result.metrics.p95_response_time),
            ),
            (
                "Max response",
                format!("{} ms", self.result.metrics.max_response_time),
            ),
            (
                "Req/s",
                format!("{:.2}", self.result.metrics.requests_per_second),
            ),
        ]
        .into_iter()
        .map(render_overview_card)
        .collect::<Vec<_>>()
        .join("")
    }

    fn summary_metrics(&self) -> Option<&SummaryMetricsMap> {
        self.parsed_summary.as_ref()?.get("metrics")?.as_object()
    }
}

fn report_styles() -> String {
    [
        BASE_STYLES,
        OVERVIEW_STYLES,
        TABLE_STYLES,
        METRIC_STYLES,
        DETAIL_STYLES,
    ]
    .join("")
}

fn render_overview_card((label, value): (&str, String)) -> String {
    format!(
        "<div class=\"overview-card\"><span>{}</span><strong>{}</strong></div>",
        escape_html(label),
        escape_html(&value)
    )
}

fn render_threshold_section(thresholds: &[ThresholdResult]) -> String {
    if thresholds.is_empty() {
        return String::new();
    }

    let rows = thresholds
        .iter()
        .map(render_threshold_row)
        .collect::<Vec<_>>()
        .join("");

    format!(
        "<section class=\"panel\"><h2>Thresholds</h2><table><thead><tr><th>Threshold</th><th>Status</th><th>Actual</th><th>Target</th></tr></thead><tbody>{rows}</tbody></table></section>"
    )
}

fn render_threshold_row(threshold: &ThresholdResult) -> String {
    format!(
        "<tr><td>{}</td><td class=\"{}\">{}</td><td>{:.4}</td><td>{:.4}</td></tr>",
        escape_html(&threshold.name),
        if threshold.passed {
            "threshold-pass"
        } else {
            "threshold-fail"
        },
        if threshold.passed { "Passed" } else { "Failed" },
        threshold.actual,
        threshold.threshold,
    )
}

fn render_structured_metrics(metrics: Option<&SummaryMetricsMap>) -> String {
    let Some(metrics) = metrics else {
        return String::new();
    };

    METRIC_CATEGORY_ORDER
        .into_iter()
        .filter_map(|category| render_metric_section(category, &metrics))
        .collect::<Vec<_>>()
        .join("")
}

fn render_metric_section(category: &str, metrics: &SummaryMetricsMap) -> Option<String> {
    let mut names = metrics
        .keys()
        .filter(|name| metric_category(name) == category)
        .cloned()
        .collect::<Vec<_>>();
    names.sort();

    if names.is_empty() {
        return None;
    }

    let cards = names
        .iter()
        .filter_map(|name| metrics.get(name).map(|metric| render_metric_card(name, metric)))
        .collect::<Vec<_>>()
        .join("");

    Some(format!(
        "<section class=\"panel\"><h2>{}</h2><div class=\"metric-grid\">{}</div></section>",
        escape_html(category),
        cards
    ))
}

fn render_metric_card(name: &str, metric: &Value) -> String {
    let metric_type = metric
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("metric");
    let contains = metric
        .get("contains")
        .and_then(Value::as_str)
        .unwrap_or("default");
    let chips = metric_value_pairs(metric)
        .into_iter()
        .map(render_metric_chip)
        .collect::<Vec<_>>()
        .join("");

    format!(
        "<article class=\"metric-card\"><h3>{}</h3><div class=\"metric-meta\">Type: {} · Contains: {}</div><div class=\"chip-row\">{}</div></article>",
        escape_html(name),
        escape_html(metric_type),
        escape_html(contains),
        chips
    )
}

fn render_metric_chip((label, value): (String, String)) -> String {
    format!(
        "<span class=\"metric-chip\"><strong>{}</strong>{}</span>",
        escape_html(&label),
        escape_html(&value)
    )
}

fn metric_value_pairs(metric: &Value) -> Vec<(String, String)> {
    if let Some(values) = metric.get("values").and_then(Value::as_object) {
        let mut pairs = values
            .iter()
            .map(|(key, value)| (key.clone(), summary_value(value)))
            .collect::<Vec<_>>();
        pairs.sort_by(|left, right| left.0.cmp(&right.0));
        return pairs;
    }

    let Some(object) = metric.as_object() else {
        return Vec::new();
    };

    let mut pairs = object
        .iter()
        .filter(|(key, value)| {
            !matches!(key.as_str(), "thresholds" | "type" | "contains" | "values")
                && (value.is_number() || value.is_string() || value.is_boolean())
        })
        .map(|(key, value)| (key.clone(), summary_value(value)))
        .collect::<Vec<_>>();
    pairs.sort_by(|left, right| left.0.cmp(&right.0));
    pairs
}

fn render_raw_summary(summary_json: Option<&str>) -> String {
    let Some(summary_json) = summary_json.map(str::trim).filter(|value| !value.is_empty()) else {
        return String::new();
    };

    format!(
        "<section class=\"panel\"><h2>Raw k6 summary JSON</h2><details><summary>Show structured summary payload</summary><pre>{}</pre></details></section>",
        escape_html(summary_json)
    )
}

fn parse_summary_json(summary_json: Option<&str>) -> Option<Value> {
    let summary_json = summary_json?.trim();
    serde_json::from_str(summary_json).ok()
}

fn metric_category(metric_name: &str) -> &'static str {
    if metric_name.starts_with("http_") {
        "HTTP"
    } else if metric_name.starts_with("data_") {
        "Network"
    } else if matches!(
        metric_name,
        "vus" | "vus_max" | "iterations" | "iteration_duration" | "dropped_iterations"
    ) {
        "Execution"
    } else {
        "Checks & Other"
    }
}

fn summary_value(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(string) => string.clone(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
