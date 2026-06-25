use std::env;
use std::fmt;
#[cfg(test)]
use std::fs;
use std::path::PathBuf;

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

pub(crate) fn resolve_k6_binary(app: &AppHandle) -> Result<K6BinaryResolution, String> {
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
