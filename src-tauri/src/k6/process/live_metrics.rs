use std::fs::File;
use std::io::BufReader;
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

use super::output_forwarding::{BoundedRecord, BoundedRecordReader};

const MAX_TRACKED_RESPONSE_TIME_MS: u64 = 24 * 60 * 60 * 1000;
const RESPONSE_TIME_PRECISION_DIGITS: u8 = 3;
const MAX_METRICS_RECORD_BYTES: usize = 64 * 1024;

pub(crate) fn spawn_metrics_forwarder(
    metrics_path: PathBuf,
    app: AppHandle,
    state: SharedAppState,
    run_id: String,
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
                        reader = Some(BoundedRecordReader::new(
                            BufReader::new(file),
                            MAX_METRICS_RECORD_BYTES,
                        ));
                    }
                    Err(_) if shutdown.load(Ordering::SeqCst) => break,
                    Err(_) => {
                        thread::sleep(Duration::from_millis(50));
                        continue;
                    }
                }
            }

            let record = match reader
                .as_mut()
                .expect("metrics reader should be initialized")
                .read_record(false)
            {
                Ok(Some(record)) => Some(record),
                Ok(None) if shutdown.load(Ordering::SeqCst) => {
                    let pending = reader
                        .as_mut()
                        .expect("metrics reader should be initialized")
                        .finish_pending();
                    if let Some(record) = pending {
                        apply_metric_record(&mut aggregator, &run_id, record);
                    }
                    break;
                }
                Ok(None) => {
                    thread::sleep(Duration::from_millis(75));
                    continue;
                }
                Err(error) => {
                    log::warn!("Failed while reading live k6 metrics for run {run_id}: {error}");
                    if shutdown.load(Ordering::SeqCst) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(75));
                    continue;
                }
            };

            if record.is_some_and(|record| apply_metric_record(&mut aggregator, &run_id, record))
                && last_emit.elapsed() >= Duration::from_millis(200)
            {
                publish_live_metrics(&state, &app, &run_id, aggregator.snapshot());
                last_emit = Instant::now();
            }
        }

        publish_live_metrics(&state, &app, &run_id, aggregator.snapshot());
    })
}

fn apply_metric_record(
    aggregator: &mut LiveMetricsAggregator,
    run_id: &str,
    record: BoundedRecord,
) -> bool {
    if record.was_truncated() {
        log::warn!(
            "A live k6 metrics record for run {run_id} exceeded {MAX_METRICS_RECORD_BYTES} bytes; the remainder was discarded"
        );
        return false;
    }

    aggregator.apply_line(record.text_lossy().as_ref())
}

fn publish_live_metrics(
    state: &SharedAppState,
    app: &AppHandle,
    run_id: &str,
    metrics: LiveMetrics,
) {
    let should_emit = if let Ok(mut app_state) = state.lock() {
        if app_state
            .active_test
            .as_ref()
            .is_some_and(|active| active.run_id == run_id)
        {
            app_state.latest_metrics = Some(metrics.clone());
            true
        } else {
            false
        }
    } else {
        false
    };

    if should_emit {
        let _ = emit_k6_metrics(app, run_id, metrics);
    }
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
    total_duration_ms: u128,
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
                self.total_duration_ms = self
                    .total_duration_ms
                    .saturating_add(u128::from(clamped_value));
                if self.latency_histogram().record(clamped_value).is_err() {
                    return false;
                }
                true
            }
            _ => false,
        }
    }

    pub(crate) fn snapshot(&self) -> LiveMetrics {
        let avg = self
            .request_durations_ms
            .as_ref()
            .map(|histogram| {
                let count = histogram.len();
                if count == 0 {
                    0
                } else {
                    (self.total_duration_ms / u128::from(count))
                        .min(u128::from(MAX_TRACKED_RESPONSE_TIME_MS)) as u64
                }
            })
            .unwrap_or(0);
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
        let max = self
            .request_durations_ms
            .as_ref()
            .map(|histogram| histogram.max().min(MAX_TRACKED_RESPONSE_TIME_MS))
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
            avg_response_time: avg,
            p50_response_time: p50,
            p95_response_time: p95,
            max_response_time: max,
            requests_per_second,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn oversized_metric_record_is_skipped_and_later_line_is_applied() {
        let mut input = vec![b'x'; 256];
        input.extend_from_slice(
            b"\n{\"type\":\"Point\",\"metric\":\"http_reqs\",\"data\":{\"value\":1}}\n",
        );
        let mut reader = BoundedRecordReader::new(Cursor::new(input), 128);
        let mut aggregator = LiveMetricsAggregator::default();

        let oversized = reader.read_record(true).unwrap().unwrap();
        let valid = reader.read_record(true).unwrap().unwrap();

        assert!(oversized.was_truncated());
        assert!(!apply_metric_record(&mut aggregator, "test-run", oversized));
        assert!(aggregator.apply_line(valid.text_lossy().as_ref()));
        assert_eq!(aggregator.snapshot().total_requests, 1);
    }

    #[test]
    fn valid_metric_at_eof_without_newline_is_applied() {
        let input = b"{\"type\":\"Point\",\"metric\":\"http_reqs\",\"data\":{\"value\":2}}";
        let mut reader = BoundedRecordReader::new(Cursor::new(input), MAX_METRICS_RECORD_BYTES);
        let mut aggregator = LiveMetricsAggregator::default();

        assert!(reader.read_record(false).unwrap().is_none());
        let pending = reader.finish_pending().unwrap();

        assert!(apply_metric_record(&mut aggregator, "test-run", pending));
        assert_eq!(aggregator.snapshot().total_requests, 2);
    }
}
