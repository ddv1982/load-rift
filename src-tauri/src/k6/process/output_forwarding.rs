use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use tauri::AppHandle;

use crate::events::emit_k6_output;
use crate::state::SharedAppState;

const STDERR_TAIL_MAX_LINES: usize = 20;
const STDERR_TAIL_MAX_CHARS: usize = 4_000;

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
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(line) = line else {
                continue;
            };
            let raw_line = line.trim_end_matches(['\r', '\n']).to_string();
            let payload = if line.ends_with('\n') {
                line
            } else {
                format!("{line}\n")
            };

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

pub(crate) fn wait_for_output_forwarders(forwarders: [Option<JoinHandle<()>>; 2]) {
    for forwarder in forwarders.into_iter().flatten() {
        let _ = forwarder.join();
    }
}
