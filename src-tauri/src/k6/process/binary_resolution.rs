use std::env;
use std::ffi::OsStr;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
#[cfg(test)]
use uuid::Uuid;

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
            K6BinarySource::Path => "PATH",
        };
        formatter.write_str(value)
    }
}

pub(crate) fn resolve_k6_binary(app: &AppHandle) -> Result<K6BinaryResolution, String> {
    let mut rejected_candidates = Vec::new();
    if let Some(value) = env::var_os("LOADRIFT_K6_BIN") {
        let path = PathBuf::from(value);
        match validate_binary_candidate(&path) {
            Ok(()) => {
                return Ok(K6BinaryResolution {
                    path,
                    source: K6BinarySource::LoadriftK6BinEnv,
                });
            }
            Err(error) => {
                rejected_candidates.push(format!("LOADRIFT_K6_BIN={} ({error})", path.display()))
            }
        }
    }

    for (candidate, source) in bundled_k6_candidates(app) {
        match validate_binary_candidate(&candidate) {
            Ok(()) => {
                return Ok(K6BinaryResolution {
                    path: candidate,
                    source,
                });
            }
            Err(CandidateError::Missing) => {}
            Err(error) => rejected_candidates.push(format!("{} ({error})", candidate.display())),
        }
    }

    let path_var = env::var_os("PATH").unwrap_or_default();
    for candidate in path_k6_candidates(&path_var) {
        match validate_binary_candidate(&candidate) {
            Ok(()) => {
                return Ok(K6BinaryResolution {
                    path: candidate,
                    source: K6BinarySource::Path,
                });
            }
            Err(CandidateError::Missing) => {}
            Err(error) => rejected_candidates.push(format!("{} ({error})", candidate.display())),
        }
    }

    let mut message = k6_not_found_message().to_string();
    if !rejected_candidates.is_empty() {
        message.push_str(" Rejected candidates: ");
        message.push_str(&rejected_candidates.join("; "));
        message.push('.');
    }
    Err(message)
}

#[derive(Debug)]
enum CandidateError {
    Missing,
    Unusable(String),
}

impl fmt::Display for CandidateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CandidateError::Missing => formatter.write_str("file does not exist"),
            CandidateError::Unusable(reason) => formatter.write_str(reason),
        }
    }
}

fn validate_binary_candidate(path: &Path) -> Result<(), CandidateError> {
    let metadata = fs::metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.file_type().is_symlink() => CandidateError::Unusable(
                    "symbolic link target does not exist or cannot be inspected".to_string(),
                ),
                _ => CandidateError::Missing,
            }
        } else {
            CandidateError::Unusable(format!("could not inspect file metadata: {error}"))
        }
    })?;
    if !metadata.is_file() {
        return Err(CandidateError::Unusable(
            "path is not a regular file".to_string(),
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(CandidateError::Unusable(
                "file does not have executable permissions".to_string(),
            ));
        }
    }

    Ok(())
}

fn path_k6_candidates(path_var: &OsStr) -> Vec<PathBuf> {
    env::split_paths(path_var)
        // Empty and relative PATH entries resolve through the process working
        // directory. Do not let an untrusted current directory select k6.
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(k6_packaged_binary_name()))
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn rejects_non_executable_binary_files() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temp directory should be created");
        let binary = directory.path().join("k6");
        fs::write(&binary, "not executable").expect("test file should be written");
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o600))
            .expect("test permissions should be set");

        let error = validate_binary_candidate(&binary)
            .expect_err("non-executable files must not be selected");
        assert!(error.to_string().contains("executable permissions"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_broken_binary_symlinks_with_actionable_context() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("temp directory should be created");
        let binary = directory.path().join("k6");
        symlink(directory.path().join("missing-k6"), &binary)
            .expect("test symlink should be created");

        let error = validate_binary_candidate(&binary)
            .expect_err("a broken binary symlink must not be selected");
        assert!(error.to_string().contains("symbolic link target"));
    }

    #[test]
    fn path_candidates_preserve_order_without_working_directory_fallbacks() {
        let first = tempfile::tempdir().expect("first temp directory should be created");
        let second = tempfile::tempdir().expect("second temp directory should be created");
        let path = env::join_paths([
            PathBuf::new(),
            PathBuf::from("."),
            PathBuf::from("relative-bin"),
            first.path().to_path_buf(),
            second.path().to_path_buf(),
        ])
        .expect("test PATH should be constructed");

        assert_eq!(
            path_k6_candidates(&path),
            vec![
                first.path().join(k6_packaged_binary_name()),
                second.path().join(k6_packaged_binary_name()),
            ]
        );
    }
}
