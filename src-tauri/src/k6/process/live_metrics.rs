use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use hdrhistogram::Histogram;
use serde::Deserialize;
use tauri::AppHandle;

use crate::events::emit_k6_metrics;
use crate::models::LiveMetrics;
use crate::state::SharedAppState;

const MAX_TRACKED_RESPONSE_TIME_MS: u64 = 24 * 60 * 60 * 1000;
const RESPONSE_TIME_PRECISION_DIGITS: u8 = 3;

pub(crate) fn spawn_metrics_forwarder(
    metrics_path: PathBuf,
    app: AppHandle,
    state: SharedAppState,
    shutdown: std::sync::Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut aggregator = LiveMetricsAggregator::default();
        let mut last_emit = Instant::now()
            .checked_sub(Duration::from_millis(250))
            .unwrap_or_else(Instant::now);
        let mut reader = None;

        loop {
            if reader.is_none() {
                match File::open(&metrics_path) {
                    Ok(file) => {
                        reader = Some(BufReader::new(file));
                    }
                    Err(_) if shutdown.load(Ordering::SeqCst) => break,
                    Err(_) => {
                        thread::sleep(Duration::from_millis(50));
                        continue;
                    }
                }
            }

            let mut line = String::new();
            let bytes_read = reader
                .as_mut()
                .and_then(|file_reader| file_reader.read_line(&mut line).ok())
                .unwrap_or(0);

            if bytes_read == 0 {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }

                thread::sleep(Duration::from_millis(75));
                continue;
            }

            if aggregator.apply_line(&line) && last_emit.elapsed() >= Duration::from_millis(200) {
                publish_live_metrics(&state, &app, aggregator.snapshot());
                last_emit = Instant::now();
            }
        }

        publish_live_metrics(&state, &app, aggregator.snapshot());
    })
}

fn publish_live_metrics(state: &SharedAppState, app: &AppHandle, metrics: LiveMetrics) {
    if let Ok(mut app_state) = state.lock() {
        app_state.latest_metrics = Some(metrics.clone());
    }

    let _ = emit_k6_metrics(app, metrics);
}

#[derive(Debug, Deserialize)]
struct JsonMetricRecord {
    #[serde(rename = "type")]
    record_type: String,
    metric: String,
    data: JsonMetricPointData,
}

#[derive(Debug, Deserialize)]
struct JsonMetricPointData {
    value: f64,
}

#[derive(Default)]
pub(crate) struct LiveMetricsAggregator {
    active_vus: u32,
    total_requests: u64,
    failed_requests: u64,
    request_durations_ms: Option<Histogram<u64>>,
    started_at: Option<Instant>,
}

impl LiveMetricsAggregator {
    fn latency_histogram(&mut self) -> &mut Histogram<u64> {
        self.request_durations_ms.get_or_insert_with(|| {
            Histogram::new_with_bounds(
                1,
                MAX_TRACKED_RESPONSE_TIME_MS,
                RESPONSE_TIME_PRECISION_DIGITS,
            )
            .expect("live latency histogram configuration should remain valid")
        })
    }

    pub(crate) fn apply_line(&mut self, line: &str) -> bool {
        let Ok(record) = serde_json::from_str::<JsonMetricRecord>(line) else {
            return false;
        };
        if record.record_type != "Point" {
            return false;
        }

        if self.started_at.is_none() {
            self.started_at = Some(Instant::now());
        }

        match record.metric.as_str() {
            "vus" => {
                let active_vus = record.data.value.max(0.0).round() as u32;
                if self.active_vus == active_vus {
                    return false;
                }

                self.active_vus = active_vus;
                true
            }
            "http_reqs" => {
                self.total_requests = self
                    .total_requests
                    .saturating_add(record.data.value.max(0.0).round() as u64);
                true
            }
            "http_req_failed" => {
                self.failed_requests = self
                    .failed_requests
                    .saturating_add(record.data.value.max(0.0).round() as u64);
                true
            }
            "http_req_duration" => {
                let value = record.data.value.max(0.0).round() as u64;
                let clamped_value = value.clamp(1, MAX_TRACKED_RESPONSE_TIME_MS);
                if self.latency_histogram().record(clamped_value).is_err() {
                    return false;
                }
                true
            }
            _ => false,
        }
    }

    pub(crate) fn snapshot(&self) -> LiveMetrics {
        let p50 = self
            .request_durations_ms
            .as_ref()
            .map(|histogram| {
                histogram
                    .value_at_quantile(0.50)
                    .min(MAX_TRACKED_RESPONSE_TIME_MS)
            })
            .unwrap_or(0);
        let p95 = self
            .request_durations_ms
            .as_ref()
            .map(|histogram| {
                histogram
                    .value_at_quantile(0.95)
                    .min(MAX_TRACKED_RESPONSE_TIME_MS)
            })
            .unwrap_or(0);
        let error_rate = if self.total_requests == 0 {
            0.0
        } else {
            self.failed_requests as f64 / self.total_requests as f64
        };
        let requests_per_second = self
            .started_at
            .map(|started_at| started_at.elapsed().as_secs_f64())
            .filter(|elapsed| *elapsed > 0.0)
            .map(|elapsed| self.total_requests as f64 / elapsed)
            .unwrap_or(0.0);

        LiveMetrics {
            active_vus: self.active_vus,
            total_requests: self.total_requests,
            failed_requests: self.failed_requests,
            error_rate,
            p50_response_time: p50,
            p95_response_time: p95,
            requests_per_second,
        }
    }
}
