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
    let content = fs::read_to_string(&request.file_path)
        .map_err(|error| format!("Failed to read {}: {error}", request.file_path))?;

    service::import_collection_into_state(state.inner(), &content)
}

#[cfg(test)]
mod tests;
