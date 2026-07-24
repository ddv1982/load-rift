use std::borrow::Cow;
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::events::emit_k6_output;
use crate::state::SharedAppState;

const STDERR_TAIL_MAX_LINES: usize = 20;
const STDERR_TAIL_MAX_CHARS: usize = 4_000;
const MAX_OUTPUT_RECORD_BYTES: usize = 64 * 1024;
const FORWARDER_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
const FORWARDER_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(10);
const TRUNCATION_NOTICE: &str = "[record truncated]";

#[derive(Debug)]
pub(crate) struct BoundedRecord {
    bytes: Vec<u8>,
    truncated: bool,
}

impl BoundedRecord {
    pub(crate) fn was_truncated(&self) -> bool {
        self.truncated
    }

    pub(crate) fn text_lossy(&self) -> Cow<'_, str> {
        String::from_utf8_lossy(&self.bytes)
    }

    fn into_output_line(self) -> String {
        let mut line = String::from_utf8_lossy(&self.bytes).into_owned();
        if self.truncated {
            if !line.is_empty() {
                line.push(' ');
            }
            line.push_str(TRUNCATION_NOTICE);
        }
        line
    }
}

/// Reads newline-delimited records without allowing a single record to grow
/// the backing allocation beyond `max_record_bytes`. Once the limit is
/// exceeded, bytes are discarded through the next newline so the following
/// record remains readable.
pub(crate) struct BoundedRecordReader<R> {
    reader: R,
    max_record_bytes: usize,
    bytes: Vec<u8>,
    truncated: bool,
}

impl<R: BufRead> BoundedRecordReader<R> {
    pub(crate) fn new(reader: R, max_record_bytes: usize) -> Self {
        Self {
            reader,
            max_record_bytes,
            bytes: Vec::with_capacity(max_record_bytes.min(8 * 1024)),
            truncated: false,
        }
    }

    /// Returns `None` when the underlying reader is currently at EOF. If
    /// `flush_at_eof` is false, a partial record is retained for a later poll.
    pub(crate) fn read_record(&mut self, flush_at_eof: bool) -> io::Result<Option<BoundedRecord>> {
        loop {
            let (available_len, newline_index, copy_len) = {
                let available = self.reader.fill_buf()?;
                if available.is_empty() {
                    return if flush_at_eof {
                        Ok(self.finish_pending())
                    } else {
                        Ok(None)
                    };
                }

                let newline_index = available.iter().position(|byte| *byte == b'\n');
                let record_bytes = newline_index.unwrap_or(available.len());
                let copy_len = if self.truncated {
                    0
                } else {
                    record_bytes.min(self.max_record_bytes.saturating_sub(self.bytes.len()))
                };
                if copy_len > 0 {
                    self.bytes.extend_from_slice(&available[..copy_len]);
                }

                (available.len(), newline_index, copy_len)
            };

            let record_bytes = newline_index.unwrap_or(available_len);
            if !self.truncated && copy_len < record_bytes {
                self.truncated = true;
            }

            let delimiter_bytes = if newline_index.is_some() { 1 } else { 0 };
            self.reader.consume(record_bytes + delimiter_bytes);
            if newline_index.is_some() {
                return Ok(Some(self.finish_record(true)));
            }
        }
    }

    pub(crate) fn finish_pending(&mut self) -> Option<BoundedRecord> {
        if self.bytes.is_empty() && !self.truncated {
            None
        } else {
            Some(self.finish_record(false))
        }
    }

    fn finish_record(&mut self, ended_with_newline: bool) -> BoundedRecord {
        if ended_with_newline && !self.truncated && self.bytes.last() == Some(&b'\r') {
            self.bytes.pop();
        }
        let record = BoundedRecord {
            bytes: std::mem::take(&mut self.bytes),
            truncated: self.truncated,
        };
        self.truncated = false;
        record
    }
}

#[derive(Debug)]
pub(crate) struct BoundedLineBuffer {
    max_lines: usize,
    max_chars: usize,
    lines: VecDeque<String>,
}

impl BoundedLineBuffer {
    pub(crate) fn stderr_tail() -> Self {
        Self::new(STDERR_TAIL_MAX_LINES, STDERR_TAIL_MAX_CHARS)
    }

    fn new(max_lines: usize, max_chars: usize) -> Self {
        Self {
            max_lines,
            max_chars,
            lines: VecDeque::new(),
        }
    }

    fn push(&mut self, line: &str) {
        let mut line = line.trim_end_matches(['\r', '\n']).to_string();
        if line.trim().is_empty() {
            return;
        }
        if line.chars().count() > self.max_chars {
            line = line
                .chars()
                .rev()
                .take(self.max_chars)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
        }
        self.lines.push_back(line);
        self.trim_to_limits();
    }

    fn text(&self) -> String {
        self.lines.iter().cloned().collect::<Vec<_>>().join("\n")
    }

    fn trim_to_limits(&mut self) {
        while self.lines.len() > self.max_lines {
            self.lines.pop_front();
        }
        while self.total_chars() > self.max_chars {
            if self.lines.pop_front().is_none() {
                break;
            }
        }
    }

    fn total_chars(&self) -> usize {
        self.lines.iter().map(|line| line.chars().count()).sum()
    }
}

pub(crate) fn spawn_output_forwarder(
    stream: Option<impl std::io::Read + Send + 'static>,
    app: AppHandle,
    state: SharedAppState,
    run_id: String,
    stderr_tail: Option<Arc<Mutex<BoundedLineBuffer>>>,
) -> Option<JoinHandle<()>> {
    let stream = stream?;

    Some(thread::spawn(move || {
        let mut reader = BoundedRecordReader::new(BufReader::new(stream), MAX_OUTPUT_RECORD_BYTES);
        loop {
            let record = match reader.read_record(true) {
                Ok(Some(record)) => record,
                Ok(None) => break,
                Err(error) => {
                    log::warn!("Failed while reading k6 output for run {run_id}: {error}");
                    break;
                }
            };
            if record.was_truncated() {
                log::warn!(
                    "A k6 output record for run {run_id} exceeded {MAX_OUTPUT_RECORD_BYTES} bytes; the remainder was discarded"
                );
            }
            let raw_line = record.into_output_line();
            let payload = format!("{raw_line}\n");

            let should_emit = if let Ok(mut app_state) = state.lock() {
                if app_state
                    .active_test
                    .as_ref()
                    .is_some_and(|active| active.run_id == run_id)
                {
                    app_state.append_latest_output(&payload);
                    true
                } else {
                    false
                }
            } else {
                false
            };

            if should_emit {
                if let Some(stderr_tail) = stderr_tail.as_ref() {
                    if let Ok(mut tail) = stderr_tail.lock() {
                        tail.push(&raw_line);
                    }
                }
                let _ = emit_k6_output(&app, &payload);
            }
        }
    }))
}

pub(crate) fn append_run_output_and_emit(
    state: &SharedAppState,
    app: &AppHandle,
    run_id: &str,
    message: &str,
) {
    let should_emit = if let Ok(mut app_state) = state.lock() {
        let latest_run_matches = app_state.latest_run_id.as_deref() == Some(run_id);
        let active_matches = app_state
            .active_test
            .as_ref()
            .is_some_and(|active| active.run_id == run_id);
        if latest_run_matches && (active_matches || app_state.active_test.is_none()) {
            app_state.append_latest_output(message);
            true
        } else {
            false
        }
    } else {
        false
    };

    if should_emit {
        let _ = emit_k6_output(app, message);
    }
}

pub(crate) fn stderr_tail_snapshot(stderr_tail: &Arc<Mutex<BoundedLineBuffer>>) -> String {
    stderr_tail
        .lock()
        .map(|tail| tail.text())
        .unwrap_or_default()
}

pub(crate) fn primary_error_from_stderr(stderr_tail: &str, exit_code: Option<i32>) -> String {
    let stderr_tail = stderr_tail.trim();
    if !stderr_tail.is_empty() {
        return stderr_tail.to_string();
    }

    if let Some(code) = exit_code {
        format!("k6 exited with status code {code}.")
    } else {
        "k6 exited with a non-zero status.".to_string()
    }
}

#[derive(Debug, Default)]
pub(crate) struct ForwarderWaitReport {
    pub(crate) timed_out: Vec<&'static str>,
    pub(crate) warnings: Vec<String>,
}

pub(crate) fn wait_for_forwarders(
    forwarders: impl IntoIterator<Item = (&'static str, Option<JoinHandle<()>>)>,
) -> ForwarderWaitReport {
    wait_for_forwarders_with_timeout(forwarders, FORWARDER_WAIT_TIMEOUT)
}

fn wait_for_forwarders_with_timeout(
    forwarders: impl IntoIterator<Item = (&'static str, Option<JoinHandle<()>>)>,
    timeout: Duration,
) -> ForwarderWaitReport {
    let deadline = Instant::now() + timeout;
    let mut report = ForwarderWaitReport::default();

    for (name, forwarder) in forwarders {
        let Some(forwarder) = forwarder else {
            continue;
        };
        while !forwarder.is_finished() && Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            thread::sleep(FORWARDER_WAIT_POLL_INTERVAL.min(remaining));
        }

        if !forwarder.is_finished() {
            let warning = format!(
                "Timed out waiting for the k6 {name} forwarder; detaching its reader so run settlement can continue."
            );
            log::warn!("{warning}");
            report.timed_out.push(name);
            report.warnings.push(warning);
            continue;
        }

        if forwarder.join().is_err() {
            let warning = format!(
                "The k6 {name} forwarder panicked; run settlement will continue without it."
            );
            log::warn!("{warning}");
            report.warnings.push(warning);
        }
    }

    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn oversized_unterminated_record_is_bounded_and_utf8_safe() {
        let input = vec![b'x'; 128];
        let mut reader = BoundedRecordReader::new(Cursor::new(input), 16);

        let record = reader.read_record(true).unwrap().unwrap();

        assert!(record.was_truncated());
        assert_eq!(record.bytes.len(), 16);
        assert!(record.text_lossy().is_ascii());
        assert!(record.into_output_line().ends_with(TRUNCATION_NOTICE));
        assert!(reader.read_record(true).unwrap().is_none());
    }

    #[test]
    fn oversized_record_discards_to_newline_and_recovers_next_record() {
        let mut input = vec![b'x'; 128];
        input.extend_from_slice(b"\nvalid\n");
        let mut reader = BoundedRecordReader::new(Cursor::new(input), 16);

        let oversized = reader.read_record(true).unwrap().unwrap();
        let recovered = reader.read_record(true).unwrap().unwrap();

        assert!(oversized.was_truncated());
        assert_eq!(recovered.text_lossy(), "valid");
        assert!(!recovered.was_truncated());
    }

    #[test]
    fn exact_limit_and_invalid_utf8_produce_safe_records() {
        let mut input = vec![b'a'; 8];
        input.extend_from_slice(b"\n\xff\xfe\n");
        let mut reader = BoundedRecordReader::new(Cursor::new(input), 8);

        let exact = reader.read_record(true).unwrap().unwrap();
        let invalid = reader.read_record(true).unwrap().unwrap();

        assert!(!exact.was_truncated());
        assert_eq!(exact.bytes.len(), 8);
        assert_eq!(invalid.text_lossy(), "��");
    }

    #[test]
    fn forwarder_wait_detaches_after_deadline() {
        let forwarder = thread::spawn(|| thread::sleep(Duration::from_millis(100)));

        let report =
            wait_for_forwarders_with_timeout([("test", Some(forwarder))], Duration::from_millis(5));

        assert_eq!(report.timed_out, vec!["test"]);
        assert_eq!(report.warnings.len(), 1);
    }
}
