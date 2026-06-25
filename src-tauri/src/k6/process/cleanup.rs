use std::process::{Child, ExitStatus};
use std::sync::{Arc, Mutex};

use tauri::AppHandle;

use crate::state::SharedAppState;

use super::artifacts::{
    ArtifactCleanupAction, ArtifactCleanupOutcome, ArtifactRetentionPolicy, RunTempArtifacts,
};
use super::output_forwarding::append_run_output_and_emit;

#[derive(Debug)]
pub(crate) enum ChildSettlement {
    Settled { status: ExitStatus, killed: bool },
    Unsettled { message: String },
}

pub(crate) fn terminate_and_reap_child(child: &mut Child) -> ChildSettlement {
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

pub(crate) fn cleanup_after_post_spawn_start_failure(
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

pub(crate) fn finish_artifact_cleanup(
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

pub(crate) fn log_artifact_cleanup(cleanup: &ArtifactCleanupOutcome) {
    match cleanup.action {
        ArtifactCleanupAction::Failed => log::warn!("{}", cleanup.message),
        ArtifactCleanupAction::Removed | ArtifactCleanupAction::Preserved => {
            log::info!("{}", cleanup.message)
        }
    }
}
