use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::diagnostics::{redact_loadrift_temp_paths, RunArtifactDiagnostics};

pub(crate) struct RunTempArtifacts {
    dir: tempfile::TempDir,
    pub(crate) script_path: PathBuf,
    pub(crate) summary_path: PathBuf,
    pub(crate) metrics_path: PathBuf,
}

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
    pub(crate) fn from_env() -> Self {
        match env::var(PRESERVE_ARTIFACTS_ENV) {
            Ok(value) if is_truthy_env_value(&value) => Self::PreserveDebug,
            _ => Self::Delete,
        }
    }

    pub(crate) fn preserve_debug(self) -> bool {
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
    pub(crate) message: String,
}

impl ArtifactCleanupOutcome {
    pub(crate) fn message_for_user(&self, include_paths: bool) -> String {
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
    pub(crate) fn diagnostics(&self) -> RunArtifactDiagnostics {
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

#[cfg(test)]
pub(crate) fn create_run_temp_artifacts(script: &str) -> Result<RunTempArtifacts, String> {
    create_run_temp_artifacts_with_policy(script, ArtifactRetentionPolicy::Delete)
}

pub(crate) fn create_run_temp_artifacts_with_policy(
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
