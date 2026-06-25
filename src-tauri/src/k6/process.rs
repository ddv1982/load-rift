mod artifacts;
mod binary_resolution;
mod cleanup;
mod completion;
mod diagnostics;
mod launch;
mod live_metrics;
mod output_forwarding;
mod state;

pub(crate) use artifacts::cleanup_stale_k6_temp_artifacts_on_startup;
#[cfg(test)]
pub(crate) use artifacts::{
    cleanup_stale_k6_temp_artifacts_in, create_run_temp_artifacts, ArtifactCleanupAction,
    ArtifactRetentionPolicy,
};
#[cfg(test)]
pub(crate) use binary_resolution::{target_triple_for, temp_file_path, write_temp_file};
#[cfg(test)]
pub(crate) use diagnostics::{
    temp_artifact_diagnostics_output_for_test, temp_artifact_diagnostics_user_output_for_test,
};
pub(crate) use launch::{analyze_advanced_options_json, validate_advanced_options_json};
pub use launch::{start_k6_process, stop_k6_process};
#[cfg(test)]
pub(crate) use live_metrics::LiveMetricsAggregator;
#[cfg(test)]
pub(crate) use output_forwarding::primary_error_from_stderr;
#[cfg(test)]
pub(crate) use state::{completion_status, mark_stopped, store_completion, CompletionRecord};
