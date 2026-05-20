use std::collections::VecDeque;
use std::env;
use std::fmt;
use std::fs;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};
#[cfg(test)]
use uuid::Uuid;

pub(crate) struct RunTempArtifacts {
    dir: tempfile::TempDir,
    pub(crate) script_path: PathBuf,
    pub(crate) summary_path: PathBuf,
    pub(crate) metrics_path: PathBuf,
}

const STDERR_TAIL_MAX_LINES: usize = 20;
const STDERR_TAIL_MAX_CHARS: usize = 4_000;
const ARTIFACT_MARKER_FILE: &str = ".loadrift-k6-artifacts.json";
const ARTIFACT_OWNER: &str = "loadrift";
const ARTIFACT_KIND: &str = "k6-run-artifacts";
const ARTIFACT_SCHEMA_VERSION: u8 = 1;
const ARTIFACT_PID_ROLE_PENDING: &str = "pendingK6Child";
const ARTIFACT_PID_ROLE_K6_CHILD: &str = "k6Child";
const STALE_ARTIFACT_THRESHOLD: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const PRESERVE_ARTIFACTS_ENV: &str = "LOADRIFT_PRESERVE_K6_ARTIFACTS";

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub(crate) enum ArtifactRetentionPolicy {
    Delete,
    PreserveDebug,
}

impl ArtifactRetentionPolicy {
    fn from_env() -> Self {
        match env::var(PRESERVE_ARTIFACTS_ENV) {
            Ok(value) if is_truthy_env_value(&value) => Self::PreserveDebug,
            _ => Self::Delete,
        }
    }

    fn preserve_debug(self) -> bool {
        matches!(self, Self::PreserveDebug)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ArtifactCleanupAction {
    Removed,
    Preserved,
    Failed,
}

#[derive(Debug)]
pub(crate) struct ArtifactCleanupOutcome {
    pub(crate) action: ArtifactCleanupAction,
    message: String,
}

impl ArtifactCleanupOutcome {
    fn message_for_user(&self, include_paths: bool) -> String {
        if include_paths {
            return self.message.clone();
        }

        redact_loadrift_temp_paths(&self.message)
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct StaleArtifactCleanupReport {
    pub(crate) scanned: usize,
    pub(crate) removed: usize,
    pub(crate) skipped_fresh: usize,
    pub(crate) skipped_preserved: usize,
    pub(crate) skipped_unsafe: usize,
    pub(crate) failed: usize,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactMarker {
    owner: String,
    kind: String,
    schema_version: u8,
    created_at_unix_seconds: u64,
    pid: u32,
    pid_role: String,
    preserve_debug: bool,
}

impl ArtifactMarker {
    fn provisional(policy: ArtifactRetentionPolicy) -> Self {
        Self {
            owner: ARTIFACT_OWNER.to_string(),
            kind: ARTIFACT_KIND.to_string(),
            schema_version: ARTIFACT_SCHEMA_VERSION,
            created_at_unix_seconds: unix_seconds(SystemTime::now()),
            pid: 0,
            pid_role: ARTIFACT_PID_ROLE_PENDING.to_string(),
            preserve_debug: policy.preserve_debug(),
        }
    }

    fn for_child_pid(policy: ArtifactRetentionPolicy, child_pid: u32) -> Self {
        Self {
            pid: child_pid,
            pid_role: ARTIFACT_PID_ROLE_K6_CHILD.to_string(),
            ..Self::provisional(policy)
        }
    }

    fn is_loadrift_k6_artifact(&self) -> bool {
        self.owner == ARTIFACT_OWNER
            && self.kind == ARTIFACT_KIND
            && self.schema_version == ARTIFACT_SCHEMA_VERSION
            && self.pid_role == ARTIFACT_PID_ROLE_K6_CHILD
    }
}

impl RunTempArtifacts {
    fn diagnostics(&self) -> RunArtifactDiagnostics {
        RunArtifactDiagnostics::capture(self)
    }

    #[cfg(test)]
    pub(crate) fn dir_path(&self) -> &Path {
        self.dir.path()
    }

    pub(crate) fn mark_spawned_child(
        &self,
        child_pid: u32,
        policy: ArtifactRetentionPolicy,
    ) -> Result<(), String> {
        let marker_path = self.dir.path().join(ARTIFACT_MARKER_FILE);
        let marker_json =
            serde_json::to_string_pretty(&ArtifactMarker::for_child_pid(policy, child_pid))
                .map_err(|error| format!("Failed to serialize k6 artifact marker: {error}"))?;
        write_private_file_replace(&marker_path, &marker_json)
    }

    pub(crate) fn cleanup(self, policy: ArtifactRetentionPolicy) -> ArtifactCleanupOutcome {
        let dir_path = self.dir.path().to_path_buf();
        match policy {
            ArtifactRetentionPolicy::Delete => match self.dir.close() {
                Ok(()) => ArtifactCleanupOutcome {
                    action: ArtifactCleanupAction::Removed,
                    message: format!("Removed k6 temp artifacts at {}", dir_path.display()),
                },
                Err(error) => ArtifactCleanupOutcome {
                    action: ArtifactCleanupAction::Failed,
                    message: format!(
                        "Failed to remove k6 temp artifacts at {}: {error}",
                        dir_path.display()
                    ),
                },
            },
            ArtifactRetentionPolicy::PreserveDebug => {
                let preserved_path = self.dir.keep();
                ArtifactCleanupOutcome {
                    action: ArtifactCleanupAction::Preserved,
                    message: format!(
                        "Load Rift preserved k6 temp artifacts for debugging at {}. The directory may contain request URLs, headers, bodies, and tokens; delete it manually when finished.",
                        preserved_path.display()
                    ),
                }
            }
        }
    }
}

fn is_truthy_env_value(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn unix_seconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[derive(Clone, Debug)]
pub(crate) struct K6BinaryResolution {
    pub(crate) path: PathBuf,
    pub(crate) source: K6BinarySource,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum K6BinarySource {
    LoadriftK6BinEnv,
    TauriResource,
    ExecutableDirectory,
    CurrentExecutableDirectory,
    ManifestBin,
    WorkingDirectory,
    Path,
}

impl fmt::Display for K6BinarySource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            K6BinarySource::LoadriftK6BinEnv => "LOADRIFT_K6_BIN",
            K6BinarySource::TauriResource => "tauri_resource",
            K6BinarySource::ExecutableDirectory => "executable_directory",
            K6BinarySource::CurrentExecutableDirectory => "current_executable_directory",
            K6BinarySource::ManifestBin => "manifest_bin",
            K6BinarySource::WorkingDirectory => "working_directory",
            K6BinarySource::Path => "PATH",
        };
        formatter.write_str(value)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct FileDiagnostic {
    path: PathBuf,
    exists: bool,
    is_file: bool,
    len: Option<u64>,
    readonly: Option<bool>,
    metadata_error: Option<String>,
    #[cfg(unix)]
    unix_mode: Option<u32>,
}

impl FileDiagnostic {
    fn capture(path: &Path) -> Self {
        match fs::metadata(path) {
            Ok(metadata) => Self {
                path: path.to_path_buf(),
                exists: true,
                is_file: metadata.is_file(),
                len: Some(metadata.len()),
                readonly: Some(metadata.permissions().readonly()),
                metadata_error: None,
                #[cfg(unix)]
                unix_mode: Some(metadata.permissions().mode() & 0o777),
            },
            Err(error) => Self {
                path: path.to_path_buf(),
                exists: path.try_exists().unwrap_or(false),
                is_file: false,
                len: None,
                readonly: None,
                metadata_error: Some(format!("{:?}: {error}", error.kind())),
                #[cfg(unix)]
                unix_mode: None,
            },
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct RunArtifactDiagnostics {
    script: FileDiagnostic,
    summary: FileDiagnostic,
    metrics: FileDiagnostic,
}

impl RunArtifactDiagnostics {
    fn capture(artifacts: &RunTempArtifacts) -> Self {
        Self {
            script: FileDiagnostic::capture(&artifacts.script_path),
            summary: FileDiagnostic::capture(&artifacts.summary_path),
            metrics: FileDiagnostic::capture(&artifacts.metrics_path),
        }
    }
}

#[derive(Debug)]
struct BoundedLineBuffer {
    max_lines: usize,
    max_chars: usize,
    lines: VecDeque<String>,
}

impl BoundedLineBuffer {
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

use crate::events::{emit_k6_complete, emit_k6_error, emit_k6_metrics, emit_k6_output};
use crate::models::{K6Options, LiveMetrics, TestCompletion, TestResultSource, TrafficMode};
use crate::state::{RunningTest, SharedAppState};

use super::super::summary::{parse_summary, result_from_live_metrics};
use super::live_metrics::spawn_metrics_forwarder;
use super::state::{
    completion_status, mark_stopped, store_completion, store_started_state, CompletionRecord,
    UPDATE_STATE_ERROR,
};

pub fn start_k6_process(
    app: AppHandle,
    state: SharedAppState,
    script: String,
    options: K6Options,
    run_id: String,
) -> Result<(), String> {
    let advanced_options = analyze_advanced_options_json(options.advanced_options_json.as_deref())?;
    let variable_overrides_json = serde_json::to_string(&options.variable_overrides)
        .map_err(|error| format!("Failed to serialize runtime variable overrides: {error}"))?;
    let selected_request_ids_json = serde_json::to_string(&options.selected_request_ids)
        .map_err(|error| format!("Failed to serialize selected request ids: {error}"))?;
    let request_weights_json = serde_json::to_string(&options.request_weights)
        .map_err(|error| format!("Failed to serialize request weights: {error}"))?;
    let effective_traffic_mode = if advanced_options.has_scenarios {
        TrafficMode::Sequential
    } else {
        options.traffic_mode.clone()
    };
    let k6_binary = resolve_k6_binary(&app)?;
    let retention_policy = ArtifactRetentionPolicy::from_env();
    let artifacts = create_run_temp_artifacts_with_policy(&script, retention_policy)?;
    let pre_spawn_diagnostics = artifacts.diagnostics();
    log::info!(
        "Launching k6 run {run_id}: binary={} source={} artifacts={}",
        k6_binary.path.display(),
        k6_binary.source,
        format_artifact_diagnostics(&pre_spawn_diagnostics)
    );
    let script_path = artifacts.script_path.clone();
    let summary_path = artifacts.summary_path.clone();
    let metrics_path = artifacts.metrics_path.clone();

    let mut command = Command::new(&k6_binary.path);
    command
        .arg("run")
        .arg("--summary-export")
        .arg(&summary_path)
        .arg("--out")
        .arg(format!("json={}", metrics_path.display()))
        .arg(&script_path)
        .env("K6_NO_COLOR", "true")
        .env("K6_NEW_MACHINE_READABLE_SUMMARY", "true")
        .env("K6_SUMMARY_MODE", "full")
        .env("K6_WEB_DASHBOARD", "false")
        .env("K6_VUS", options.vus.to_string())
        .env("K6_DURATION", &options.duration)
        .env(
            "K6_RAMP_UP",
            format!("{:?}", options.ramp_up).to_lowercase(),
        )
        .env(
            "K6_RAMP_UP_TIME",
            options.ramp_up_time.as_deref().unwrap_or("30s"),
        )
        .env("LOADRIFT_VARIABLE_OVERRIDES_JSON", variable_overrides_json)
        .env(
            "LOADRIFT_SELECTED_REQUEST_IDS_JSON",
            selected_request_ids_json,
        )
        .env("LOADRIFT_REQUEST_WEIGHTS_JSON", request_weights_json)
        .env(
            "LOADRIFT_TRAFFIC_MODE",
            match effective_traffic_mode {
                TrafficMode::Weighted => "weighted",
                TrafficMode::Sequential => "sequential",
            },
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(value) = advanced_options.normalized_json.as_deref() {
        command.env("LOADRIFT_ADVANCED_OPTIONS_JSON", value);
    }
    if advanced_options.overrides_basic_load_shape {
        command.env("LOADRIFT_SKIP_BASIC_LOAD_SHAPE", "true");
    }

    if let Some(value) = options.thresholds.p95_response_time {
        command.env("K6_P95_THRESHOLD_MS", value.to_string());
    }

    if let Some(value) = options.thresholds.error_rate {
        command.env("K6_ERROR_RATE_THRESHOLD_PERCENT", value.to_string());
    }

    if let Some(value) = options
        .auth_token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        command.env("AUTH_TOKEN", value);
    }

    if let Some(value) = options
        .base_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        command.env("BASE_URL", value);
    }

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let cleanup = artifacts.cleanup(retention_policy);
            log_artifact_cleanup(&cleanup);
            return Err(format!(
                "Failed to start k6 at {} (source: {}): {error}. Artifact diagnostics before spawn: {}. {}",
                k6_binary.path.display(),
                k6_binary.source,
                format_artifact_diagnostics_for_user(
                    &pre_spawn_diagnostics,
                    retention_policy.preserve_debug()
                ),
                cleanup.message_for_user(retention_policy.preserve_debug())
            ));
        }
    };

    let child_pid = child.id();
    let child = std::sync::Arc::new(std::sync::Mutex::new(child));
    if let Err(error) = artifacts.mark_spawned_child(child_pid, retention_policy) {
        return Err(cleanup_after_post_spawn_start_failure(
            child,
            artifacts,
            retention_policy,
            error,
        ));
    }

    let stop_requested = std::sync::Arc::new(AtomicBool::new(false));
    let metrics_shutdown = Arc::new(AtomicBool::new(false));
    let stderr_tail = Arc::new(Mutex::new(BoundedLineBuffer::new(
        STDERR_TAIL_MAX_LINES,
        STDERR_TAIL_MAX_CHARS,
    )));

    {
        let initial_metrics = LiveMetrics::default();
        let running_test = RunningTest {
            run_id: run_id.clone(),
            child: child.clone(),
            stop_requested: stop_requested.clone(),
        };

        if let Err(error) = store_started_state(&state, initial_metrics.clone(), running_test) {
            return Err(cleanup_after_post_spawn_start_failure(
                child,
                artifacts,
                retention_policy,
                error,
            ));
        }
        let _ = emit_k6_metrics(&app, &run_id, initial_metrics);
    }

    let (stdout, stderr) = {
        let mut child = match child.lock() {
            Ok(child) => child,
            Err(poisoned) => {
                log::warn!("k6 child mutex was poisoned while preparing output forwarders; recovering ownership");
                poisoned.into_inner()
            }
        };
        (child.stdout.take(), child.stderr.take())
    };

    let stdout_forwarder =
        spawn_output_forwarder(stdout, app.clone(), state.clone(), run_id.clone(), None);
    let stderr_forwarder = spawn_output_forwarder(
        stderr,
        app.clone(),
        state.clone(),
        run_id.clone(),
        Some(stderr_tail.clone()),
    );
    let metrics_forwarder = spawn_metrics_forwarder(
        metrics_path.clone(),
        app.clone(),
        state.clone(),
        run_id.clone(),
        metrics_shutdown.clone(),
    );
    spawn_waiter(
        child,
        stop_requested,
        artifacts,
        stdout_forwarder,
        stderr_forwarder,
        metrics_forwarder,
        metrics_shutdown,
        k6_binary,
        pre_spawn_diagnostics,
        retention_policy,
        stderr_tail,
        app,
        state,
        run_id,
        options.vus,
    );

    Ok(())
}

pub(crate) fn validate_advanced_options_json(
    value: Option<&str>,
) -> Result<Option<String>, String> {
    analyze_advanced_options_json(value).map(|config| config.normalized_json)
}

pub fn stop_k6_process(state: &SharedAppState) -> Result<String, String> {
    let running = {
        let app_state = state.lock().map_err(|_| UPDATE_STATE_ERROR.to_string())?;
        app_state.active_test.clone()
    };

    let Some(running) = running else {
        return Err("No k6 test is currently running.".to_string());
    };

    running.stop_requested.store(true, Ordering::SeqCst);

    let mut child = running
        .child
        .lock()
        .map_err(|_| "Failed to access the active k6 process.".to_string())?;
    child
        .kill()
        .map_err(|error| format!("Failed to stop the active k6 process: {error}"))?;

    Ok(running.run_id)
}

fn spawn_output_forwarder(
    stream: Option<impl std::io::Read + Send + 'static>,
    app: AppHandle,
    state: SharedAppState,
    run_id: String,
    stderr_tail: Option<Arc<Mutex<BoundedLineBuffer>>>,
) -> Option<JoinHandle<()>> {
    let Some(stream) = stream else {
        return None;
    };

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
                    app_state.latest_output.push_str(&payload);
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

#[derive(Debug)]
enum ChildSettlement {
    Settled { status: ExitStatus, killed: bool },
    Unsettled { message: String },
}

fn terminate_and_reap_child(child: &mut Child) -> ChildSettlement {
    match child.try_wait() {
        Ok(Some(status)) => {
            return ChildSettlement::Settled {
                status,
                killed: false,
            };
        }
        Ok(None) => {}
        Err(error) => {
            log::warn!("Failed to check k6 child status before termination: {error}");
        }
    }

    let killed = match child.kill() {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => false,
        Err(error) => {
            return ChildSettlement::Unsettled {
                message: format!("Failed to terminate k6 child process: {error}"),
            };
        }
    };

    match child.wait() {
        Ok(status) => ChildSettlement::Settled { status, killed },
        Err(error) => ChildSettlement::Unsettled {
            message: format!("Failed to reap k6 child process: {error}"),
        },
    }
}

fn cleanup_after_post_spawn_start_failure(
    child: Arc<Mutex<Child>>,
    artifacts: RunTempArtifacts,
    policy: ArtifactRetentionPolicy,
    original_error: String,
) -> String {
    let settlement = {
        let mut child = match child.lock() {
            Ok(child) => child,
            Err(poisoned) => {
                log::warn!("k6 child mutex was poisoned during post-spawn startup cleanup; recovering ownership");
                poisoned.into_inner()
            }
        };
        terminate_and_reap_child(&mut child)
    };

    let (cleanup_policy, settlement_message) = match settlement {
        ChildSettlement::Settled { killed, .. } => (
            policy,
            if killed {
                "The spawned k6 process was terminated and reaped before artifact cleanup."
                    .to_string()
            } else {
                "The spawned k6 process had already exited and was reaped before artifact cleanup."
                    .to_string()
            },
        ),
        ChildSettlement::Unsettled { message } => (
            ArtifactRetentionPolicy::PreserveDebug,
            format!("{message}; preserving temp artifacts because k6 may still be running."),
        ),
    };
    let cleanup = artifacts.cleanup(cleanup_policy);
    log_artifact_cleanup(&cleanup);

    format!(
        "{original_error}. {settlement_message} {}",
        cleanup.message_for_user(policy.preserve_debug())
    )
}

fn spawn_waiter(
    child: std::sync::Arc<std::sync::Mutex<Child>>,
    stop_requested: std::sync::Arc<std::sync::atomic::AtomicBool>,
    artifacts: RunTempArtifacts,
    stdout_forwarder: Option<JoinHandle<()>>,
    stderr_forwarder: Option<JoinHandle<()>>,
    metrics_forwarder: JoinHandle<()>,
    metrics_shutdown: Arc<AtomicBool>,
    k6_binary: K6BinaryResolution,
    pre_spawn_diagnostics: RunArtifactDiagnostics,
    retention_policy: ArtifactRetentionPolicy,
    stderr_tail: Arc<Mutex<BoundedLineBuffer>>,
    app: AppHandle,
    state: SharedAppState,
    run_id: String,
    configured_vus: u32,
) {
    thread::spawn(move || {
        let summary_path = artifacts.summary_path.clone();
        let exit_status = loop {
            let maybe_status = {
                let mut child = match child.lock() {
                    Ok(child) => child,
                    Err(poisoned) => {
                        log::warn!(
                            "k6 child mutex was poisoned while waiting; recovering ownership"
                        );
                        poisoned.into_inner()
                    }
                };
                match child.try_wait() {
                    Ok(status) => status,
                    Err(error) => {
                        log::warn!(
                            "Failed while waiting for the k6 process: {error}; attempting to settle child before updating run state"
                        );
                        match terminate_and_reap_child(&mut child) {
                            ChildSettlement::Settled { status, .. } => Some(status),
                            ChildSettlement::Unsettled { message } => {
                                log::warn!(
                                    "{message}; keeping active k6 state and temp artifacts because child state is uncertain"
                                );
                                None
                            }
                        }
                    }
                }
            };

            if let Some(status) = maybe_status {
                break status;
            }

            thread::sleep(Duration::from_millis(200));
        };

        let stop_requested = stop_requested.load(Ordering::SeqCst);
        metrics_shutdown.store(true, Ordering::SeqCst);
        let _ = metrics_forwarder.join();
        wait_for_output_forwarders([stdout_forwarder, stderr_forwarder]);
        let stderr_tail = stderr_tail_snapshot(&stderr_tail);

        if stop_requested {
            if mark_stopped(&state, &run_id) {
                let _ = emit_k6_output(&app, "k6 run stopped.\n");
            }
            finish_artifact_cleanup(artifacts, retention_policy, &state, &app, &run_id);
            return;
        }

        match fs::read_to_string(&summary_path) {
            Ok(summary_json) => match parse_summary(&summary_json, configured_vus) {
                Ok((result, metrics)) => {
                    emit_completion(
                        &app,
                        &state,
                        &run_id,
                        exit_status.success(),
                        exit_status.code(),
                        metrics,
                        result,
                        Some(summary_json.clone()),
                        TestResultSource::Summary,
                        None,
                        retention_policy.preserve_debug(),
                        &stderr_tail,
                    );
                }
                Err(error) => {
                    emit_live_metrics_fallback_completion(
                        &app,
                        &state,
                        &run_id,
                        exit_status.success(),
                        exit_status.code(),
                        Some(summary_json.clone()),
                        &error,
                        &k6_binary,
                        &pre_spawn_diagnostics,
                        &artifacts.diagnostics(),
                        retention_policy,
                        &stderr_tail,
                    );
                }
            },
            Err(error) => {
                emit_live_metrics_fallback_completion(
                    &app,
                    &state,
                    &run_id,
                    exit_status.success(),
                    exit_status.code(),
                    None,
                    &summary_file_issue(&summary_path, &error, retention_policy.preserve_debug()),
                    &k6_binary,
                    &pre_spawn_diagnostics,
                    &artifacts.diagnostics(),
                    retention_policy,
                    &stderr_tail,
                );
            }
        }

        finish_artifact_cleanup(artifacts, retention_policy, &state, &app, &run_id);
    });
}

fn emit_completion(
    app: &AppHandle,
    state: &SharedAppState,
    run_id: &str,
    exited_successfully: bool,
    exit_code: Option<i32>,
    metrics: LiveMetrics,
    mut result: crate::models::TestResult,
    summary_json: Option<String>,
    result_source: TestResultSource,
    summary_issue: Option<String>,
    include_artifact_paths: bool,
    stderr_tail: &str,
) -> bool {
    let completion = completion_status(exited_successfully, exit_code, &result);
    if completion.threshold_failure_exit {
        result.status = crate::models::TestResultStatus::Failed;
    }
    let error_message = if !exited_successfully && !completion.threshold_failure_exit {
        let message = primary_error_from_stderr(stderr_tail, exit_code);
        Some(if include_artifact_paths {
            message
        } else {
            redact_loadrift_temp_paths(&message)
        })
    } else {
        None
    };
    let stored = store_completion(
        state,
        run_id,
        CompletionRecord {
            metrics: metrics.clone(),
            result: result.clone(),
            run_state: completion.run_state.clone(),
            finish_reason: completion.finish_reason.clone(),
            summary_json,
            result_source: result_source.clone(),
            summary_issue: summary_issue.clone(),
            error_message: error_message.clone(),
        },
    );

    if !stored {
        return false;
    }

    let _ = emit_k6_metrics(app, run_id, metrics.clone());
    let _ = emit_k6_complete(
        app,
        TestCompletion {
            run_id: run_id.to_string(),
            run_state: completion.run_state.clone(),
            finish_reason: completion.finish_reason.clone(),
            metrics,
            result,
            result_source,
            summary_issue,
            error_message: error_message.clone(),
        },
    );

    if completion.threshold_failure_exit {
        let _ = emit_k6_output(
            app,
            "k6 finished with failed thresholds. Review the latest result for the final metrics.\n",
        );
    } else if let Some(error_message) = error_message {
        let _ = emit_k6_error(app, run_id, &error_message);
    }

    true
}

fn emit_live_metrics_fallback_completion(
    app: &AppHandle,
    state: &SharedAppState,
    run_id: &str,
    exited_successfully: bool,
    exit_code: Option<i32>,
    summary_json: Option<String>,
    summary_issue: &str,
    k6_binary: &K6BinaryResolution,
    pre_spawn_diagnostics: &RunArtifactDiagnostics,
    fallback_diagnostics: &RunArtifactDiagnostics,
    retention_policy: ArtifactRetentionPolicy,
    stderr_tail: &str,
) {
    let metrics = state
        .lock()
        .ok()
        .and_then(|app_state| app_state.latest_metrics.clone())
        .unwrap_or_default();
    let result = result_from_live_metrics(&metrics, exit_code);

    let stored = emit_completion(
        app,
        state,
        run_id,
        exited_successfully,
        exit_code,
        metrics,
        result,
        summary_json,
        TestResultSource::LiveMetricsFallback,
        Some(summary_issue.to_string()),
        retention_policy.preserve_debug(),
        stderr_tail,
    );

    if !stored {
        return;
    }

    let include_paths = retention_policy.preserve_debug();
    let message = format!(
        "Load Rift used live metrics because the structured k6 summary could not be processed: {summary_issue}\n"
    );
    append_run_output_and_emit(state, app, run_id, &message);

    log::warn!(
        "Load Rift k6 fallback diagnostics: binary={} source={} exitCode={} beforeSpawn=[{}] fallback=[{}]",
        k6_binary.path.display(),
        k6_binary.source,
        exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        format_artifact_diagnostics(pre_spawn_diagnostics),
        format_artifact_diagnostics(fallback_diagnostics)
    );
    let diagnostics = format!(
        "Load Rift k6 diagnostics: binary={} source={} exitCode={} beforeSpawn=[{}] fallback=[{}]\n",
        if include_paths {
            k6_binary.path.display().to_string()
        } else {
            "<redacted>".to_string()
        },
        k6_binary.source,
        exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        format_artifact_diagnostics_for_user(pre_spawn_diagnostics, include_paths),
        format_artifact_diagnostics_for_user(fallback_diagnostics, include_paths)
    );
    append_run_output_and_emit(state, app, run_id, &diagnostics);
}

fn finish_artifact_cleanup(
    artifacts: RunTempArtifacts,
    policy: ArtifactRetentionPolicy,
    state: &SharedAppState,
    app: &AppHandle,
    run_id: &str,
) {
    let cleanup = artifacts.cleanup(policy);
    log_artifact_cleanup(&cleanup);
    if matches!(
        cleanup.action,
        ArtifactCleanupAction::Failed | ArtifactCleanupAction::Preserved
    ) {
        append_run_output_and_emit(
            state,
            app,
            run_id,
            &format!("{}\n", cleanup.message_for_user(policy.preserve_debug())),
        );
    }
}

fn log_artifact_cleanup(cleanup: &ArtifactCleanupOutcome) {
    match cleanup.action {
        ArtifactCleanupAction::Failed => log::warn!("{}", cleanup.message),
        ArtifactCleanupAction::Removed | ArtifactCleanupAction::Preserved => {
            log::info!("{}", cleanup.message)
        }
    }
}

fn append_run_output_and_emit(
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
            app_state.latest_output.push_str(message);
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

fn stderr_tail_snapshot(stderr_tail: &Arc<Mutex<BoundedLineBuffer>>) -> String {
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

fn format_artifact_diagnostics(diagnostics: &RunArtifactDiagnostics) -> String {
    format!(
        "script={{ {} }}; summary={{ {} }}; metrics={{ {} }}",
        format_file_diagnostic(&diagnostics.script),
        format_file_diagnostic(&diagnostics.summary),
        format_file_diagnostic(&diagnostics.metrics)
    )
}

fn format_artifact_diagnostics_for_user(
    diagnostics: &RunArtifactDiagnostics,
    include_paths: bool,
) -> String {
    format!(
        "script={{ {} }}; summary={{ {} }}; metrics={{ {} }}",
        format_file_diagnostic_with_path_mode(&diagnostics.script, include_paths),
        format_file_diagnostic_with_path_mode(&diagnostics.summary, include_paths),
        format_file_diagnostic_with_path_mode(&diagnostics.metrics, include_paths)
    )
}

fn format_file_diagnostic(diagnostic: &FileDiagnostic) -> String {
    format_file_diagnostic_with_path_mode(diagnostic, true)
}

fn format_file_diagnostic_with_path_mode(
    diagnostic: &FileDiagnostic,
    include_path: bool,
) -> String {
    let mut parts = vec![
        format!(
            "path={}",
            if include_path {
                diagnostic.path.display().to_string()
            } else {
                "<redacted>".to_string()
            }
        ),
        format!("exists={}", diagnostic.exists),
        format!("isFile={}", diagnostic.is_file),
        format!(
            "len={}",
            diagnostic
                .len
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ),
        format!(
            "readonly={}",
            diagnostic
                .readonly
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ),
        format!(
            "metadataError={}",
            diagnostic.metadata_error.as_deref().unwrap_or("none")
        ),
    ];

    #[cfg(unix)]
    parts.push(format!(
        "mode={}",
        diagnostic
            .unix_mode
            .map(|value| format!("{value:o}"))
            .unwrap_or_else(|| "unknown".to_string())
    ));

    parts.join(", ")
}

fn summary_file_issue(path: &Path, error: &std::io::Error, include_path: bool) -> String {
    format!(
        "k6 finished without a readable summary file at {}: {error}",
        if include_path {
            path.display().to_string()
        } else {
            "<redacted>".to_string()
        }
    )
}

fn redact_loadrift_temp_paths(message: &str) -> String {
    message
        .split_whitespace()
        .map(|part| {
            let has_path_separator = part.contains('/') || part.contains('\\');
            if part.contains("loadrift-") && (has_path_separator || part.starts_with("path=")) {
                let suffix = part
                    .chars()
                    .rev()
                    .take_while(|ch| matches!(ch, '.' | ',' | ';' | ':'))
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>();
                format!("path=<redacted>{suffix}")
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
pub(crate) fn temp_artifact_diagnostics_output_for_test(artifacts: &RunTempArtifacts) -> String {
    format_artifact_diagnostics(&RunArtifactDiagnostics::capture(artifacts))
}

#[cfg(test)]
pub(crate) fn temp_artifact_diagnostics_user_output_for_test(
    artifacts: &RunTempArtifacts,
    include_paths: bool,
) -> String {
    format_artifact_diagnostics_for_user(&RunArtifactDiagnostics::capture(artifacts), include_paths)
}

fn wait_for_output_forwarders(forwarders: [Option<JoinHandle<()>>; 2]) {
    for forwarder in forwarders.into_iter().flatten() {
        let _ = forwarder.join();
    }
}

pub(crate) fn analyze_advanced_options_json(
    value: Option<&str>,
) -> Result<AdvancedOptionsConfig, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(AdvancedOptionsConfig::default());
    };

    let parsed: Value = serde_json::from_str(value)
        .map_err(|error| format!("Advanced k6 options must be valid JSON: {error}"))?;
    let object = parsed
        .as_object()
        .ok_or("Advanced k6 options must be a JSON object.".to_string())?;

    Ok(AdvancedOptionsConfig {
        normalized_json: Some(value.to_string()),
        overrides_basic_load_shape: advanced_options_override_basic_load_shape(object),
        has_scenarios: object.contains_key("scenarios"),
    })
}

fn advanced_options_override_basic_load_shape(options: &Map<String, Value>) -> bool {
    // These top-level k6 keys define the load shape themselves, so they must
    // bypass the app's basic `vus` / `duration` / `stages` injection. Keep this
    // list aligned with the advanced options we intentionally allow to override
    // the basic runner controls.
    ["scenarios", "stages", "iterations"]
        .iter()
        .any(|key| options.contains_key(*key))
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct AdvancedOptionsConfig {
    pub(crate) normalized_json: Option<String>,
    pub(crate) overrides_basic_load_shape: bool,
    pub(crate) has_scenarios: bool,
}

#[cfg(test)]
pub(crate) fn create_run_temp_artifacts(script: &str) -> Result<RunTempArtifacts, String> {
    create_run_temp_artifacts_with_policy(script, ArtifactRetentionPolicy::Delete)
}

fn create_run_temp_artifacts_with_policy(
    script: &str,
    policy: ArtifactRetentionPolicy,
) -> Result<RunTempArtifacts, String> {
    let dir = tempfile::Builder::new()
        .prefix("loadrift-")
        .tempdir()
        .map_err(|error| format!("Failed to create a private k6 temp directory: {error}"))?;

    #[cfg(unix)]
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).map_err(|error| {
        format!(
            "Failed to restrict k6 temp directory permissions at {}: {error}",
            dir.path().display()
        )
    })?;

    let script_path = dir.path().join("script.js");
    write_private_file(&script_path, script)?;

    let marker_path = dir.path().join(ARTIFACT_MARKER_FILE);
    let marker_json = serde_json::to_string_pretty(&ArtifactMarker::provisional(policy))
        .map_err(|error| format!("Failed to serialize k6 artifact marker: {error}"))?;
    write_private_file(&marker_path, &marker_json)?;

    Ok(RunTempArtifacts {
        summary_path: dir.path().join("summary.json"),
        metrics_path: dir.path().join("metrics.json"),
        script_path,
        dir,
    })
}

fn write_private_file(path: &Path, content: &str) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);

    #[cfg(unix)]
    options.mode(0o600);

    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

fn write_private_file_replace(path: &Path, content: &str) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).truncate(true);

    #[cfg(unix)]
    options.mode(0o600);

    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to update {}: {error}", path.display()))?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("Failed to update {}: {error}", path.display()))
}

pub(crate) fn cleanup_stale_k6_temp_artifacts_on_startup() -> StaleArtifactCleanupReport {
    let report = cleanup_stale_k6_temp_artifacts_in(&env::temp_dir(), SystemTime::now());
    log::info!(
        "k6 temp artifact startup cleanup: scanned={} removed={} skippedFresh={} skippedPreserved={} skippedUnsafe={} failed={}",
        report.scanned,
        report.removed,
        report.skipped_fresh,
        report.skipped_preserved,
        report.skipped_unsafe,
        report.failed
    );
    report
}

pub(crate) fn cleanup_stale_k6_temp_artifacts_in(
    root: &Path,
    now: SystemTime,
) -> StaleArtifactCleanupReport {
    let mut report = StaleArtifactCleanupReport::default();
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => {
            report.failed += 1;
            log::warn!(
                "Failed to scan k6 temp artifact root {}: {error}",
                root.display()
            );
            return report;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                report.failed += 1;
                log::warn!(
                    "Failed to read a k6 temp artifact root entry under {}: {error}",
                    root.display()
                );
                continue;
            }
        };
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("loadrift-") {
            continue;
        }

        report.scanned += 1;
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                report.skipped_unsafe += 1;
                log::warn!(
                    "Skipping k6 temp artifact candidate {} because file type could not be read: {error}",
                    path.display()
                );
                continue;
            }
        };

        if file_type.is_symlink() || !file_type.is_dir() {
            report.skipped_unsafe += 1;
            continue;
        }

        match stale_artifact_cleanup_decision(&path, now) {
            StaleArtifactDecision::Remove => match fs::remove_dir_all(&path) {
                Ok(()) => {
                    report.removed += 1;
                    log::info!("Removed stale k6 temp artifacts at {}", path.display());
                }
                Err(error) => {
                    report.failed += 1;
                    log::warn!(
                        "Failed to remove stale k6 temp artifacts at {}: {error}",
                        path.display()
                    );
                }
            },
            StaleArtifactDecision::Fresh => report.skipped_fresh += 1,
            StaleArtifactDecision::Preserved => report.skipped_preserved += 1,
            StaleArtifactDecision::Unsafe => report.skipped_unsafe += 1,
        }
    }

    report
}

enum StaleArtifactDecision {
    Remove,
    Fresh,
    Preserved,
    Unsafe,
}

fn stale_artifact_cleanup_decision(path: &Path, now: SystemTime) -> StaleArtifactDecision {
    let marker_path = path.join(ARTIFACT_MARKER_FILE);
    if marker_path.is_file() {
        return stale_marker_artifact_cleanup_decision(path, &marker_path, now);
    }

    log::info!(
        "Skipping markerless k6 temp artifact candidate {}; startup cleanup only removes marker-owned artifact dirs",
        path.display()
    );
    StaleArtifactDecision::Unsafe
}

fn stale_marker_artifact_cleanup_decision(
    path: &Path,
    marker_path: &Path,
    now: SystemTime,
) -> StaleArtifactDecision {
    let marker_json = match fs::read_to_string(marker_path) {
        Ok(marker_json) => marker_json,
        Err(error) => {
            log::warn!(
                "Skipping k6 temp artifact candidate {} because its marker could not be read: {error}",
                path.display()
            );
            return StaleArtifactDecision::Unsafe;
        }
    };
    let marker: ArtifactMarker = match serde_json::from_str(&marker_json) {
        Ok(marker) => marker,
        Err(error) => {
            log::warn!(
                "Skipping k6 temp artifact candidate {} because its marker is invalid: {error}",
                path.display()
            );
            return StaleArtifactDecision::Unsafe;
        }
    };

    if !marker.is_loadrift_k6_artifact() {
        return StaleArtifactDecision::Unsafe;
    }
    if marker.preserve_debug {
        return StaleArtifactDecision::Preserved;
    }
    match process_liveness(marker.pid) {
        ProcessLiveness::Alive | ProcessLiveness::Unknown => return StaleArtifactDecision::Fresh,
        ProcessLiveness::NotAlive => {}
    }
    if !is_stale_unix_seconds(marker.created_at_unix_seconds, now) {
        return StaleArtifactDecision::Fresh;
    }
    if let Err(error) = validate_expected_artifact_shape(path, marker_path) {
        log::warn!(
            "Skipping k6 temp artifact candidate {} because its shape is unsafe: {error}",
            path.display()
        );
        return StaleArtifactDecision::Unsafe;
    }

    match newest_child_modified(path) {
        Ok(Some(modified)) if is_stale_system_time(modified, now) => StaleArtifactDecision::Remove,
        Ok(Some(_)) => StaleArtifactDecision::Fresh,
        Ok(None) => StaleArtifactDecision::Remove,
        Err(error) => {
            log::warn!(
                "Skipping k6 temp artifact candidate {} because its contents could not be inspected: {error}",
                path.display()
            );
            StaleArtifactDecision::Unsafe
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum ProcessLiveness {
    Alive,
    NotAlive,
    Unknown,
}

#[cfg(unix)]
fn process_liveness(pid: u32) -> ProcessLiveness {
    if pid == 0 || pid > i32::MAX as u32 {
        return ProcessLiveness::Unknown;
    }

    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    // Signal 0 performs a POSIX liveness check without sending a signal.
    if unsafe { kill(pid as i32, 0) } == 0 {
        return ProcessLiveness::Alive;
    }

    match std::io::Error::last_os_error().raw_os_error() {
        Some(3) => ProcessLiveness::NotAlive, // ESRCH
        Some(1) => ProcessLiveness::Unknown,  // EPERM
        _ => ProcessLiveness::Unknown,
    }
}

#[cfg(not(unix))]
fn process_liveness(_pid: u32) -> ProcessLiveness {
    ProcessLiveness::Unknown
}

fn validate_expected_artifact_shape(path: &Path, marker_path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("directory metadata could not be read: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("candidate is not a real directory".to_string());
    }

    let marker_metadata = fs::symlink_metadata(marker_path)
        .map_err(|error| format!("marker metadata could not be read: {error}"))?;
    if marker_metadata.file_type().is_symlink() || !marker_metadata.is_file() {
        return Err("marker is not a regular file".to_string());
    }

    let mut saw_script = false;
    for entry in
        fs::read_dir(path).map_err(|error| format!("directory could not be read: {error}"))?
    {
        let entry = entry.map_err(|error| format!("directory entry could not be read: {error}"))?;
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("file type could not be read for {file_name}: {error}"))?;

        if file_type.is_symlink() {
            return Err(format!("{file_name} is a symlink"));
        }
        if !file_type.is_file() {
            return Err(format!("{file_name} is not a regular file"));
        }

        match file_name.as_ref() {
            ARTIFACT_MARKER_FILE | "summary.json" | "metrics.json" => {}
            "script.js" => saw_script = true,
            _ => return Err(format!("{file_name} is not a known k6 artifact file")),
        }
    }

    if !saw_script {
        return Err("script.js is missing".to_string());
    }

    Ok(())
}

fn newest_child_modified(path: &Path) -> Result<Option<SystemTime>, std::io::Error> {
    let mut newest_modified: Option<SystemTime> = None;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let modified = entry.metadata()?.modified()?;
        newest_modified = Some(match newest_modified {
            Some(existing) => existing.max(modified),
            None => modified,
        });
    }
    Ok(newest_modified)
}

fn is_stale_unix_seconds(created_at_unix_seconds: u64, now: SystemTime) -> bool {
    let now = unix_seconds(now);
    now.saturating_sub(created_at_unix_seconds) > STALE_ARTIFACT_THRESHOLD.as_secs()
}

fn is_stale_system_time(time: SystemTime, now: SystemTime) -> bool {
    now.duration_since(time)
        .map(|age| age > STALE_ARTIFACT_THRESHOLD)
        .unwrap_or(false)
}

fn resolve_k6_binary(app: &AppHandle) -> Result<K6BinaryResolution, String> {
    if let Ok(value) = env::var("LOADRIFT_K6_BIN") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(K6BinaryResolution {
                path,
                source: K6BinarySource::LoadriftK6BinEnv,
            });
        }
    }

    for (candidate, source) in bundled_k6_candidates(app) {
        if candidate.is_file() {
            return Ok(K6BinaryResolution {
                path: candidate,
                source,
            });
        }
    }

    for candidate in ["k6", "./k6", "./bin/k6"] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Ok(K6BinaryResolution {
                path,
                source: K6BinarySource::WorkingDirectory,
            });
        }
    }

    let path_var = env::var_os("PATH").unwrap_or_default();
    for directory in env::split_paths(&path_var) {
        let candidate = directory.join("k6");
        if candidate.is_file() {
            return Ok(K6BinaryResolution {
                path: candidate,
                source: K6BinarySource::Path,
            });
        }
    }

    Err(k6_not_found_message().to_string())
}

fn k6_not_found_message() -> &'static str {
    if current_target_triple().is_some() {
        "Could not find a k6 binary. Run `npm run install:k6`, rebuild the app, or set LOADRIFT_K6_BIN to the executable path."
    } else {
        "No bundled k6 binary is available for this platform. Install k6 on PATH or set LOADRIFT_K6_BIN to an executable path."
    }
}

fn bundled_k6_candidates(app: &AppHandle) -> Vec<(PathBuf, K6BinarySource)> {
    let mut candidates = Vec::new();
    let target_binary_name = current_target_triple().map(|triple| format!("k6-{triple}"));

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_bundled_candidates(
            &mut candidates,
            resource_dir.join("bin"),
            target_binary_name.as_deref(),
            K6BinarySource::TauriResource,
        );
        push_bundled_candidates(
            &mut candidates,
            resource_dir,
            target_binary_name.as_deref(),
            K6BinarySource::TauriResource,
        );
    }

    if let Ok(executable_dir) = app.path().executable_dir() {
        push_bundled_candidates(
            &mut candidates,
            executable_dir.join("bin"),
            target_binary_name.as_deref(),
            K6BinarySource::ExecutableDirectory,
        );
        push_bundled_candidates(
            &mut candidates,
            executable_dir,
            target_binary_name.as_deref(),
            K6BinarySource::ExecutableDirectory,
        );
    }

    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            push_bundled_candidates(
                &mut candidates,
                parent.join("bin"),
                target_binary_name.as_deref(),
                K6BinarySource::CurrentExecutableDirectory,
            );
            push_bundled_candidates(
                &mut candidates,
                parent.to_path_buf(),
                target_binary_name.as_deref(),
                K6BinarySource::CurrentExecutableDirectory,
            );
        }
    }

    if let Some(target_binary_name) = target_binary_name.as_deref() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        candidates.push((
            manifest_dir.join("bin").join(target_binary_name),
            K6BinarySource::ManifestBin,
        ));
    }

    candidates
}

fn push_bundled_candidates(
    candidates: &mut Vec<(PathBuf, K6BinarySource)>,
    directory: PathBuf,
    target_binary_name: Option<&str>,
    source: K6BinarySource,
) {
    if let Some(target_binary_name) = target_binary_name {
        candidates.push((directory.join(target_binary_name), source.clone()));
    }
    candidates.push((directory.join(k6_packaged_binary_name()), source));
}

fn k6_packaged_binary_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "k6.exe"
    }

    #[cfg(not(target_os = "windows"))]
    {
        "k6"
    }
}

fn current_target_triple() -> Option<&'static str> {
    target_triple_for(env::consts::OS, env::consts::ARCH)
}

pub(crate) fn target_triple_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        _ => None,
    }
}

#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn temp_file_path(extension: &str) -> PathBuf {
    env::temp_dir().join(format!("loadrift-{}.{}", Uuid::new_v4(), extension))
}

#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn write_temp_file(extension: &str, content: &str) -> Result<PathBuf, String> {
    let path = temp_file_path(extension);
    fs::write(&path, content)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    Ok(path)
}
