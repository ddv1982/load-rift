use tauri::AppHandle;

use crate::events::{emit_k6_complete, emit_k6_error, emit_k6_metrics, emit_k6_output};
use crate::models::{LiveMetrics, TestCompletion, TestResultSource};
use crate::state::SharedAppState;

use super::super::summary::result_from_live_metrics;
use super::artifacts::ArtifactRetentionPolicy;
use super::binary_resolution::K6BinaryResolution;
use super::diagnostics::{
    format_artifact_diagnostics, format_artifact_diagnostics_for_user, redact_loadrift_temp_paths,
    RunArtifactDiagnostics,
};
use super::output_forwarding::{append_run_output_and_emit, primary_error_from_stderr};
use super::state::{completion_status, store_completion, CompletionRecord};

#[derive(Clone, Copy)]
pub(crate) struct RunExit {
    pub(crate) exited_successfully: bool,
    pub(crate) exit_code: Option<i32>,
}

#[derive(Clone, Copy)]
pub(crate) struct CompletionContext<'a> {
    pub(crate) app: &'a AppHandle,
    pub(crate) state: &'a SharedAppState,
    pub(crate) run_id: &'a str,
    pub(crate) run_exit: RunExit,
    pub(crate) include_artifact_paths: bool,
    pub(crate) stderr_tail: &'a str,
}

pub(crate) struct CompletionPayload {
    pub(crate) metrics: LiveMetrics,
    pub(crate) result: crate::models::TestResult,
    pub(crate) summary_json: Option<String>,
    pub(crate) result_source: TestResultSource,
    pub(crate) summary_issue: Option<String>,
}

pub(crate) struct FallbackCompletionContext<'a> {
    pub(crate) completion: CompletionContext<'a>,
    pub(crate) summary_json: Option<String>,
    pub(crate) summary_issue: &'a str,
    pub(crate) k6_binary: &'a K6BinaryResolution,
    pub(crate) pre_spawn_diagnostics: &'a RunArtifactDiagnostics,
    pub(crate) fallback_diagnostics: &'a RunArtifactDiagnostics,
    pub(crate) retention_policy: ArtifactRetentionPolicy,
}

pub(crate) fn emit_completion(context: CompletionContext<'_>, payload: CompletionPayload) -> bool {
    let CompletionPayload {
        metrics,
        mut result,
        summary_json,
        result_source,
        summary_issue,
    } = payload;
    let completion = completion_status(
        context.run_exit.exited_successfully,
        context.run_exit.exit_code,
        &result,
    );
    if completion.threshold_failure_exit {
        result.status = crate::models::TestResultStatus::Failed;
    }
    let error_message = if !context.run_exit.exited_successfully
        && !completion.threshold_failure_exit
    {
        let message = primary_error_from_stderr(context.stderr_tail, context.run_exit.exit_code);
        Some(if context.include_artifact_paths {
            message
        } else {
            redact_loadrift_temp_paths(&message)
        })
    } else {
        None
    };
    let stored = store_completion(
        context.state,
        context.run_id,
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

    let _ = emit_k6_metrics(context.app, context.run_id, metrics.clone());
    let _ = emit_k6_complete(
        context.app,
        TestCompletion {
            run_id: context.run_id.to_string(),
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
            context.app,
            "k6 finished with failed thresholds. Review the latest result for the final metrics.\n",
        );
    } else if let Some(error_message) = error_message {
        let _ = emit_k6_error(context.app, context.run_id, &error_message);
    }

    true
}

pub(crate) fn emit_live_metrics_fallback_completion(context: FallbackCompletionContext<'_>) {
    let metrics = context
        .completion
        .state
        .lock()
        .ok()
        .and_then(|app_state| app_state.latest_metrics.clone())
        .unwrap_or_default();
    let result = result_from_live_metrics(&metrics, context.completion.run_exit.exit_code);

    let stored = emit_completion(
        context.completion,
        CompletionPayload {
            metrics,
            result,
            summary_json: context.summary_json,
            result_source: TestResultSource::LiveMetricsFallback,
            summary_issue: Some(context.summary_issue.to_string()),
        },
    );

    if !stored {
        return;
    }

    let include_paths = context.retention_policy.preserve_debug();
    let message = format!(
        "Load Rift used live metrics because the structured k6 summary could not be processed: {}\n",
        context.summary_issue
    );
    append_run_output_and_emit(
        context.completion.state,
        context.completion.app,
        context.completion.run_id,
        &message,
    );

    log::warn!(
        "Load Rift k6 fallback diagnostics: binary={} source={} exitCode={} beforeSpawn=[{}] fallback=[{}]",
        context.k6_binary.path.display(),
        context.k6_binary.source,
        context
            .completion
            .run_exit
            .exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        format_artifact_diagnostics(context.pre_spawn_diagnostics),
        format_artifact_diagnostics(context.fallback_diagnostics)
    );
    let diagnostics = format!(
        "Load Rift k6 diagnostics: binary={} source={} exitCode={} beforeSpawn=[{}] fallback=[{}]\n",
        if include_paths {
            context.k6_binary.path.display().to_string()
        } else {
            "<redacted>".to_string()
        },
        context.k6_binary.source,
        context
            .completion
            .run_exit
            .exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        format_artifact_diagnostics_for_user(context.pre_spawn_diagnostics, include_paths),
        format_artifact_diagnostics_for_user(context.fallback_diagnostics, include_paths)
    );
    append_run_output_and_emit(
        context.completion.state,
        context.completion.app,
        context.completion.run_id,
        &diagnostics,
    );
}
