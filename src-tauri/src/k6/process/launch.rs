use std::fs;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{Map, Value};
use tauri::AppHandle;

use crate::events::emit_k6_metrics;
use crate::models::{K6Options, LiveMetrics, TestResultSource, TrafficMode};
use crate::state::{RunningTest, SharedAppState};

use super::super::summary::parse_summary;
use super::artifacts::{
    create_run_temp_artifacts_with_policy, ArtifactRetentionPolicy, RunTempArtifacts,
};
use super::binary_resolution::{resolve_k6_binary, K6BinaryResolution};
use super::cleanup::{
    cleanup_after_post_spawn_start_failure, finish_artifact_cleanup, log_artifact_cleanup,
    terminate_and_reap_child, ChildSettlement,
};
use super::completion::{
    emit_completion, emit_live_metrics_fallback_completion, CompletionContext, CompletionPayload,
    FallbackCompletionContext, RunExit,
};
use super::diagnostics::{
    format_artifact_diagnostics, format_artifact_diagnostics_for_user, summary_file_issue,
    RunArtifactDiagnostics,
};
use super::live_metrics::spawn_metrics_forwarder;
use super::output_forwarding::{
    spawn_output_forwarder, stderr_tail_snapshot, wait_for_output_forwarders, BoundedLineBuffer,
};
use super::state::{mark_stopped, store_started_state, UPDATE_STATE_ERROR};

pub fn start_k6_process(
    app: AppHandle,
    state: SharedAppState,
    script: String,
    options: K6Options,
    run_id: String,
) -> Result<(), String> {
    launch_k6_process(RunLaunchContext {
        app,
        state,
        script,
        options,
        run_id,
    })
}

struct RunLaunchContext {
    app: AppHandle,
    state: SharedAppState,
    script: String,
    options: K6Options,
    run_id: String,
}

fn launch_k6_process(context: RunLaunchContext) -> Result<(), String> {
    let RunLaunchContext {
        app,
        state,
        script,
        options,
        run_id,
    } = context;
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
        .and_then(crate::importing::normalize_auth_token_input)
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
    let child = Arc::new(Mutex::new(child));
    if let Err(error) = artifacts.mark_spawned_child(child_pid, retention_policy) {
        return Err(cleanup_after_post_spawn_start_failure(
            child,
            artifacts,
            retention_policy,
            error,
        ));
    }

    let stop_requested = Arc::new(AtomicBool::new(false));
    let metrics_shutdown = Arc::new(AtomicBool::new(false));
    let stderr_tail = Arc::new(Mutex::new(BoundedLineBuffer::stderr_tail()));

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
    spawn_waiter(RunWaitContext {
        child,
        stop_requested,
        artifacts,
        forwarders: WaitForwarders {
            stdout: stdout_forwarder,
            stderr: stderr_forwarder,
            metrics: metrics_forwarder,
        },
        metrics_shutdown,
        k6_binary,
        pre_spawn_diagnostics,
        retention_policy,
        stderr_tail,
        app,
        state,
        run_id,
        configured_vus: options.vus,
    });

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

struct WaitForwarders {
    stdout: Option<JoinHandle<()>>,
    stderr: Option<JoinHandle<()>>,
    metrics: JoinHandle<()>,
}

struct RunWaitContext {
    child: Arc<Mutex<Child>>,
    stop_requested: Arc<AtomicBool>,
    artifacts: RunTempArtifacts,
    forwarders: WaitForwarders,
    metrics_shutdown: Arc<AtomicBool>,
    k6_binary: K6BinaryResolution,
    pre_spawn_diagnostics: RunArtifactDiagnostics,
    retention_policy: ArtifactRetentionPolicy,
    stderr_tail: Arc<Mutex<BoundedLineBuffer>>,
    app: AppHandle,
    state: SharedAppState,
    run_id: String,
    configured_vus: u32,
}

fn spawn_waiter(context: RunWaitContext) {
    thread::spawn(move || {
        let RunWaitContext {
            child,
            stop_requested,
            artifacts,
            forwarders,
            metrics_shutdown,
            k6_binary,
            pre_spawn_diagnostics,
            retention_policy,
            stderr_tail,
            app,
            state,
            run_id,
            configured_vus,
        } = context;
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
        let _ = forwarders.metrics.join();
        wait_for_output_forwarders([forwarders.stdout, forwarders.stderr]);
        let stderr_tail = stderr_tail_snapshot(&stderr_tail);

        if stop_requested {
            if mark_stopped(&state, &run_id) {
                super::output_forwarding::append_run_output_and_emit(
                    &state,
                    &app,
                    &run_id,
                    "k6 run stopped.\n",
                );
            }
            finish_artifact_cleanup(artifacts, retention_policy, &state, &app, &run_id);
            return;
        }

        let run_exit = RunExit {
            exited_successfully: exit_status.success(),
            exit_code: exit_status.code(),
        };
        let completion_context = CompletionContext {
            app: &app,
            state: &state,
            run_id: &run_id,
            run_exit,
            include_artifact_paths: retention_policy.preserve_debug(),
            stderr_tail: &stderr_tail,
        };

        match fs::read_to_string(&summary_path) {
            Ok(summary_json) => match parse_summary(&summary_json, configured_vus) {
                Ok((result, metrics)) => {
                    emit_completion(
                        completion_context,
                        CompletionPayload {
                            metrics,
                            result,
                            summary_json: Some(summary_json),
                            result_source: TestResultSource::Summary,
                            summary_issue: None,
                        },
                    );
                }
                Err(error) => {
                    let fallback_diagnostics = artifacts.diagnostics();
                    emit_live_metrics_fallback_completion(FallbackCompletionContext {
                        completion: completion_context,
                        summary_json: Some(summary_json),
                        summary_issue: &error,
                        k6_binary: &k6_binary,
                        pre_spawn_diagnostics: &pre_spawn_diagnostics,
                        fallback_diagnostics: &fallback_diagnostics,
                        retention_policy,
                    });
                }
            },
            Err(error) => {
                let summary_issue =
                    summary_file_issue(&summary_path, &error, retention_policy.preserve_debug());
                let fallback_diagnostics = artifacts.diagnostics();
                emit_live_metrics_fallback_completion(FallbackCompletionContext {
                    completion: completion_context,
                    summary_json: None,
                    summary_issue: &summary_issue,
                    k6_binary: &k6_binary,
                    pre_spawn_diagnostics: &pre_spawn_diagnostics,
                    fallback_diagnostics: &fallback_diagnostics,
                    retention_policy,
                });
            }
        }

        finish_artifact_cleanup(artifacts, retention_policy, &state, &app, &run_id);
    });
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
