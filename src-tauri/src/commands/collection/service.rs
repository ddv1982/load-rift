use std::time::Duration;

use tauri_plugin_http::reqwest;

use crate::importing::import_collection;
use crate::models::{CollectionInfo, TestStatus};
use crate::state::SharedAppState;

const UPDATE_STATE_ERROR: &str = "Failed to update the shared Tauri app state.";
const ACTIVE_TEST_IMPORT_ERROR: &str =
    "Stop the active k6 test before importing a different collection.";
const INVALID_COLLECTION_URL_ERROR: &str = "Collection URL must start with http:// or https://.";
const COLLECTION_FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_COLLECTION_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const COLLECTION_RESPONSE_TOO_LARGE_ERROR: &str =
    "Collection download exceeded the 5 MB response limit.";

pub(super) fn import_collection_into_state(
    state: &SharedAppState,
    content: &str,
) -> Result<CollectionInfo, String> {
    let imported = import_collection(content)?;
    let collection = imported.info.clone();

    let mut app_state = state.lock().map_err(|_| UPDATE_STATE_ERROR.to_string())?;
    if app_state.test_is_busy() {
        return Err(ACTIVE_TEST_IMPORT_ERROR.to_string());
    }

    app_state.collection_name = Some(collection.name.clone());
    app_state.generated_script = Some(imported.script);
    app_state.runtime_collection = Some(imported.runtime_collection);
    app_state.clear_test_run_state();
    app_state.test_status = TestStatus::Idle;

    Ok(collection)
}

pub(super) async fn fetch_url_content(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(COLLECTION_FETCH_TIMEOUT)
        .timeout(COLLECTION_FETCH_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to configure the HTTP client: {error}"))?;

    fetch_url_content_with_client(&client, url, MAX_COLLECTION_RESPONSE_BYTES).await
}

pub(super) async fn fetch_url_content_with_client(
    client: &reqwest::Client,
    url: &str,
    max_response_bytes: usize,
) -> Result<String, String> {
    if !matches!(
        reqwest::Url::parse(url),
        Ok(parsed) if matches!(parsed.scheme(), "http" | "https")
    ) {
        return Err(INVALID_COLLECTION_URL_ERROR.to_string());
    }

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Failed to fetch {url}: {error}"))?;
    let status = response.status();

    if !status.is_success() {
        return Err(format!("Failed to fetch {url}: HTTP {status}"));
    }

    if response
        .content_length()
        .is_some_and(|length| length > max_response_bytes as u64)
    {
        return Err(COLLECTION_RESPONSE_TOO_LARGE_ERROR.to_string());
    }

    let mut bytes = Vec::new();
    let mut response = response;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Failed to read the response body from {url}: {error}"))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > max_response_bytes {
            return Err(COLLECTION_RESPONSE_TOO_LARGE_ERROR.to_string());
        }
    }

    String::from_utf8(bytes)
        .map_err(|error| format!("Failed to decode the response body from {url}: {error}"))
}
