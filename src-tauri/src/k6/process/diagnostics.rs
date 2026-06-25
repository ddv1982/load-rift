use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::artifacts::RunTempArtifacts;

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
    pub(crate) fn capture(artifacts: &RunTempArtifacts) -> Self {
        Self {
            script: FileDiagnostic::capture(&artifacts.script_path),
            summary: FileDiagnostic::capture(&artifacts.summary_path),
            metrics: FileDiagnostic::capture(&artifacts.metrics_path),
        }
    }
}

pub(crate) fn format_artifact_diagnostics(diagnostics: &RunArtifactDiagnostics) -> String {
    format!(
        "script={{ {} }}; summary={{ {} }}; metrics={{ {} }}",
        format_file_diagnostic(&diagnostics.script),
        format_file_diagnostic(&diagnostics.summary),
        format_file_diagnostic(&diagnostics.metrics)
    )
}

pub(crate) fn format_artifact_diagnostics_for_user(
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

pub(crate) fn summary_file_issue(
    path: &Path,
    error: &std::io::Error,
    include_path: bool,
) -> String {
    format!(
        "k6 finished without a readable summary file at {}: {error}",
        if include_path {
            path.display().to_string()
        } else {
            "<redacted>".to_string()
        }
    )
}

pub(crate) fn redact_loadrift_temp_paths(message: &str) -> String {
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
