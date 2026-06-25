mod service;

use std::fs;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::models::CollectionInfo;
use crate::state::SharedAppState;

const MAX_COLLECTION_FILE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCollectionFromFileRequest {
    pub file_path: String,
}

#[tauri::command]
pub async fn import_collection_from_file(
    state: State<'_, SharedAppState>,
    request: ImportCollectionFromFileRequest,
) -> Result<CollectionInfo, String> {
    let state = state.inner().clone();
    let file_path = request.file_path;

    tauri::async_runtime::spawn_blocking(move || import_collection_from_path(&state, &file_path))
        .await
        .map_err(|error| format!("Failed to complete collection import task: {error}"))?
}

fn import_collection_from_path(
    state: &SharedAppState,
    file_path: &str,
) -> Result<CollectionInfo, String> {
    service::ensure_can_import_collection(state)?;

    let path = validate_import_path(file_path)?;
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;

    service::import_collection_into_state(state, &content)
}

fn validate_import_path(file_path: &str) -> Result<PathBuf, String> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return Err("Choose a Postman collection JSON file before importing.".to_string());
    }

    let requested_path = Path::new(trimmed);
    let resolved_path = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("Failed to resolve the import location: {error}"))?
            .join(requested_path)
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
