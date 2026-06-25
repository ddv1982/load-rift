mod service;

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::models::CollectionInfo;
use crate::state::SharedAppState;

const MAX_COLLECTION_FILE_BYTES: u64 = 20 * 1024 * 1024;

#[tauri::command]
pub async fn select_and_import_collection(
    app: AppHandle,
    state: State<'_, SharedAppState>,
) -> Result<Option<CollectionInfo>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Select Postman Collection")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|_| {
        "The selected collection path is not available on this platform.".to_string()
    })?;
    let state = state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || import_collection_from_path(&state, &path))
        .await
        .map_err(|error| format!("Failed to complete collection import task: {error}"))?
        .map(Some)
}

fn import_collection_from_path(
    state: &SharedAppState,
    file_path: impl AsRef<Path>,
) -> Result<CollectionInfo, String> {
    service::ensure_can_import_collection(state)?;

    let path = validate_import_path(file_path.as_ref())?;
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;

    service::import_collection_into_state(state, &content)
}

fn validate_import_path(file_path: &Path) -> Result<PathBuf, String> {
    if file_path.as_os_str().is_empty() {
        return Err("Choose a Postman collection JSON file before importing.".to_string());
    }

    let resolved_path = if file_path.is_absolute() {
        file_path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("Failed to resolve the import location: {error}"))?
            .join(file_path)
    };
    let canonical_path = fs::canonicalize(&resolved_path).map_err(|error| {
        format!(
            "Failed to resolve the import file {}: {error}",
            resolved_path.display()
        )
    })?;

    if !canonical_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return Err("Choose a Postman collection file with a .json extension.".to_string());
    }

    let metadata = fs::metadata(&canonical_path).map_err(|error| {
        format!(
            "Failed to inspect the import file {}: {error}",
            canonical_path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err("Choose a Postman collection JSON file, not a directory.".to_string());
    }
    if metadata.len() > MAX_COLLECTION_FILE_BYTES {
        return Err(format!(
            "The collection file is too large to import. Choose a file up to {} MB.",
            MAX_COLLECTION_FILE_BYTES / 1024 / 1024
        ));
    }

    Ok(canonical_path)
}

#[cfg(test)]
mod tests;
