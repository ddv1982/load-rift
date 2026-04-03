use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::events::{emit_k6_complete, emit_k6_error, emit_k6_metrics, emit_k6_output};
use crate::models::{K6Options, LiveMetrics, TestCompletion, TrafficMode};
use crate::state::{RunningTest, SharedAppState};

use super::super::summary::{parse_summary, result_from_live_metrics};
use super::live_metrics::spawn_metrics_forwarder;
use super::state::{
    completion_status, mark_stopped, record_failure, store_completion, store_started_state,
    UPDATE_STATE_ERROR,
};

pub fn start_k6_process(
    app: AppHandle,
    state: SharedAppState,
    script: String,
    options: K6Options,
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
    let script_path = write_temp_file("js", &script)?;
    let summary_path = temp_file_path("json");
    let metrics_path = temp_file_path("json");

    let mut command = Command::new(&k6_binary);
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

    let child = command.spawn().map_err(|error| {
        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_file(&summary_path);
        let _ = fs::remove_file(&metrics_path);
        format!("Failed to start k6 at {}: {error}", k6_binary.display())
    })?;

    let mut child = child;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = std::sync::Arc::new(std::sync::Mutex::new(child));
    let stop_requested = std::sync::Arc::new(AtomicBool::new(false));
    let metrics_shutdown = std::sync::Arc::new(AtomicBool::new(false));

    {
        let initial_metrics = LiveMetrics::default();
        let running_test = RunningTest {
            child: child.clone(),
            stop_requested: stop_requested.clone(),
        };

        store_started_state(&state, initial_metrics.clone(), running_test)?;
        let _ = emit_k6_metrics(&app, initial_metrics);
    }

    let stdout_forwarder = spawn_output_forwarder(stdout, app.clone(), state.clone());
    let stderr_forwarder = spawn_output_forwarder(stderr, app.clone(), state.clone());
    let metrics_forwarder = spawn_metrics_forwarder(
        metrics_path.clone(),
        app.clone(),
        state.clone(),
        metrics_shutdown.clone(),
    );
    spawn_waiter(
        child,
        stop_requested,
        summary_path,
        script_path,
        metrics_path,
        stdout_forwarder,
        stderr_forwarder,
        metrics_forwarder,
        metrics_shutdown,
        app,
        state,
        options.vus,
    );

    Ok(())
}

pub(crate) fn validate_advanced_options_json(
    value: Option<&str>,
) -> Result<Option<String>, String> {
    analyze_advanced_options_json(value).map(|config| config.normalized_json)
}

pub fn stop_k6_process(state: &SharedAppState) -> Result<(), String> {
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
        .map_err(|error| format!("Failed to stop the active k6 process: {error}"))
}

fn spawn_output_forwarder(
    stream: Option<impl std::io::Read + Send + 'static>,
    app: AppHandle,
    state: SharedAppState,
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
            let payload = if line.ends_with('\n') {
                line
            } else {
                format!("{line}\n")
            };

            if let Ok(mut app_state) = state.lock() {
                app_state.latest_output.push_str(&payload);
            }

            let _ = emit_k6_output(&app, &payload);
        }
    }))
}

fn spawn_waiter(
    child: std::sync::Arc<std::sync::Mutex<Child>>,
    stop_requested: std::sync::Arc<std::sync::atomic::AtomicBool>,
    summary_path: PathBuf,
    script_path: PathBuf,
    metrics_path: PathBuf,
    stdout_forwarder: Option<JoinHandle<()>>,
    stderr_forwarder: Option<JoinHandle<()>>,
    metrics_forwarder: JoinHandle<()>,
    metrics_shutdown: std::sync::Arc<AtomicBool>,
    app: AppHandle,
    state: SharedAppState,
    configured_vus: u32,
) {
    thread::spawn(move || {
        let exit_status = loop {
            let maybe_status = {
                let mut child = match child.lock() {
                    Ok(child) => child,
                    Err(_) => return,
                };
                match child.try_wait() {
                    Ok(status) => status,
                    Err(error) => {
                        let message = format!("Failed while waiting for the k6 process: {error}");
                        record_failure(&state, &app, &message);
                        return;
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
        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_file(&metrics_path);
        wait_for_output_forwarders([stdout_forwarder, stderr_forwarder]);

        if stop_requested {
            mark_stopped(&state);
            let _ = emit_k6_output(&app, "k6 run stopped.\n");
            let _ = fs::remove_file(&summary_path);
            return;
        }

        match fs::read_to_string(&summary_path) {
            Ok(summary_json) => match parse_summary(&summary_json, configured_vus) {
                Ok((result, metrics)) => {
                    emit_completion(
                        &app,
                        &state,
                        exit_status.success(),
                        exit_status.code(),
                        metrics,
                        result,
                        Some(summary_json.clone()),
                    );
                }
                Err(error) => {
                    emit_live_metrics_fallback_completion(
                        &app,
                        &state,
                        exit_status.success(),
                        exit_status.code(),
                        Some(summary_json.clone()),
                        &error,
                    );
                }
            },
            Err(error) => {
                emit_live_metrics_fallback_completion(
                    &app,
                    &state,
                    exit_status.success(),
                    exit_status.code(),
                    None,
                    &format!(
                        "k6 finished without a readable summary file at {}: {error}",
                        summary_path.display()
                    ),
                );
            }
        }

        let _ = fs::remove_file(&summary_path);
    });
}

fn emit_completion(
    app: &AppHandle,
    state: &SharedAppState,
    exited_successfully: bool,
    exit_code: Option<i32>,
    metrics: LiveMetrics,
    mut result: crate::models::TestResult,
    summary_json: Option<String>,
) {
    let completion = completion_status(exited_successfully, exit_code, &result);
    if completion.threshold_failure_exit {
        result.status = crate::models::TestResultStatus::Failed;
    }
    store_completion(
        state,
        &metrics,
        &result,
        completion.run_state.clone(),
        &completion.finish_reason,
        summary_json,
    );

    let _ = emit_k6_metrics(app, metrics.clone());
    let _ = emit_k6_complete(
        app,
        TestCompletion {
            run_state: completion.run_state.clone(),
            finish_reason: completion.finish_reason.clone(),
            metrics,
            result,
        },
    );

    if completion.threshold_failure_exit {
        let _ = emit_k6_output(
            app,
            "k6 finished with failed thresholds. Review the latest result for the final metrics.\n",
        );
    } else if !exited_successfully {
        let _ = emit_k6_error(
            app,
            "k6 exited with a non-zero status for a reason other than threshold failures.",
        );
    }
}

fn emit_live_metrics_fallback_completion(
    app: &AppHandle,
    state: &SharedAppState,
    exited_successfully: bool,
    exit_code: Option<i32>,
    summary_json: Option<String>,
    summary_issue: &str,
) {
    let metrics = state
        .lock()
        .ok()
        .and_then(|app_state| app_state.latest_metrics.clone())
        .unwrap_or_default();
    let result = result_from_live_metrics(&metrics, exit_code);

    emit_completion(
        app,
        state,
        exited_successfully,
        exit_code,
        metrics,
        result,
        summary_json,
    );

    let message = format!(
        "Load Rift used live metrics because the structured k6 summary could not be processed: {summary_issue}\n"
    );
    let _ = emit_k6_output(app, &message);
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

fn resolve_k6_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(value) = env::var("LOADRIFT_K6_BIN") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(path);
        }
    }

    for candidate in bundled_k6_candidates(app) {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    for candidate in ["k6", "./k6", "./bin/k6"] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Ok(path);
        }
    }

    let path_var = env::var_os("PATH").unwrap_or_default();
    for directory in env::split_paths(&path_var) {
        let candidate = directory.join("k6");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Err("Could not find a k6 binary. Run `npm run install:k6`, rebuild the app, or set LOADRIFT_K6_BIN to the executable path.".to_string())
}

fn bundled_k6_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let target_binary_name = format!("k6-{}", current_target_triple());

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("bin").join(&target_binary_name));
        candidates.push(resource_dir.join("bin").join(k6_packaged_binary_name()));
        candidates.push(resource_dir.join(&target_binary_name));
        candidates.push(resource_dir.join(k6_packaged_binary_name()));
    }

    if let Ok(executable_dir) = app.path().executable_dir() {
        candidates.push(executable_dir.join("bin").join(&target_binary_name));
        candidates.push(executable_dir.join("bin").join(k6_packaged_binary_name()));
        candidates.push(executable_dir.join(&target_binary_name));
        candidates.push(executable_dir.join(k6_packaged_binary_name()));
    }

    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join("bin").join(&target_binary_name));
            candidates.push(parent.join("bin").join(k6_packaged_binary_name()));
            candidates.push(parent.join(&target_binary_name));
            candidates.push(parent.join(k6_packaged_binary_name()));
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(
        manifest_dir
            .join("bin")
            .join(format!("k6-{}", current_target_triple())),
    );

    candidates
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

fn current_target_triple() -> &'static str {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "x86_64-unknown-linux-gnu"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "aarch64-unknown-linux-gnu"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "x86_64-pc-windows-msvc"
    }
}

#[cfg(test)]
pub(crate) fn temp_file_path(extension: &str) -> PathBuf {
    env::temp_dir().join(format!("loadrift-{}.{}", Uuid::new_v4(), extension))
}

#[cfg(test)]
pub(crate) fn write_temp_file(extension: &str, content: &str) -> Result<PathBuf, String> {
    let path = temp_file_path(extension);
    fs::write(&path, content)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    Ok(path)
}

#[cfg(not(test))]
pub(crate) fn temp_file_path(extension: &str) -> PathBuf {
    env::temp_dir().join(format!("loadrift-{}.{}", Uuid::new_v4(), extension))
}

#[cfg(not(test))]
pub(crate) fn write_temp_file(extension: &str, content: &str) -> Result<PathBuf, String> {
    let path = temp_file_path(extension);
    fs::write(&path, content)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    Ok(path)
}
