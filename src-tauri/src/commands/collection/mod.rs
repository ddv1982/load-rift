mod service;

use std::fs;

use tauri::State;

use crate::models::CollectionInfo;
use crate::state::SharedAppState;

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
    import_collection_from_path(state.inner(), &request.file_path)
}

fn import_collection_from_path(
    state: &SharedAppState,
    file_path: &str,
) -> Result<CollectionInfo, String> {
    service::ensure_can_import_collection(state)?;

    let content = fs::read_to_string(file_path)
        .map_err(|error| format!("Failed to read {file_path}: {error}"))?;

    service::import_collection_into_state(state, &content)
}

#[cfg(test)]
mod tests;
