use crate::importing::import_collection;
use crate::models::{CollectionInfo, TestStatus};
use crate::state::SharedAppState;

const UPDATE_STATE_ERROR: &str = "Failed to update the shared Tauri app state.";
const ACTIVE_TEST_IMPORT_ERROR: &str =
    "Stop the active k6 test before importing a different collection.";

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

    app_state.generated_script = Some(imported.script);
    app_state.runtime_collection = Some(imported.runtime_collection);
    app_state.clear_test_run_state();
    app_state.test_status = TestStatus::Idle;

    Ok(collection)
}
