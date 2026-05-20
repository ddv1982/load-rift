mod live_metrics;
mod runtime;
mod state;

#[cfg(test)]
pub(crate) use live_metrics::LiveMetricsAggregator;
pub(crate) use runtime::{
    analyze_advanced_options_json, cleanup_stale_k6_temp_artifacts_on_startup,
    validate_advanced_options_json,
};
#[cfg(test)]
pub(crate) use runtime::{
    cleanup_stale_k6_temp_artifacts_in, create_run_temp_artifacts, primary_error_from_stderr,
    target_triple_for, temp_artifact_diagnostics_output_for_test,
    temp_artifact_diagnostics_user_output_for_test, temp_file_path, write_temp_file,
    ArtifactCleanupAction, ArtifactRetentionPolicy,
};
pub use runtime::{start_k6_process, stop_k6_process};
#[cfg(test)]
pub(crate) use state::{completion_status, mark_stopped, store_completion, CompletionRecord};
