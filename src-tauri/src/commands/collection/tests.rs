use std::sync::{Arc, Mutex};

use super::service;
use crate::models::TestStatus;
use crate::state::AppState;
use crate::test_support::{empty_runtime_collection, passed_result};

fn sample_collection() -> &'static str {
    r#"{
      "info": { "name": "Demo Collection" },
      "variable": [{ "key": "baseUrl", "value": "https://api.example.com" }],
      "item": [
        {
          "name": "List users",
          "request": {
            "method": "GET",
            "url": { "raw": "{{baseUrl}}/users" }
          }
        }
      ]
    }"#
}

#[test]
fn import_collection_into_state_persists_collection_and_script() {
    let state = Arc::new(Mutex::new(AppState::default()));

    let collection = service::import_collection_into_state(&state, sample_collection())
        .expect("import should succeed");

    let app_state = state.lock().expect("state should remain readable");
    assert_eq!(collection.name, "Demo Collection");
    assert_eq!(collection.request_count, 1);
    assert!(app_state.generated_script.is_some());
    assert_eq!(
        app_state
            .runtime_collection
            .as_ref()
            .map(|collection| collection.requests.len()),
        Some(1)
    );
    assert!(matches!(app_state.test_status, TestStatus::Idle));
}

#[test]
fn import_collection_into_state_clears_previous_run_artifacts() {
    let state = Arc::new(Mutex::new(AppState {
        runtime_collection: Some(empty_runtime_collection()),
        latest_result: Some(passed_result()),
        latest_finish_reason: Some("completed".to_string()),
        latest_error_message: Some("old error".to_string()),
        latest_output: "previous output".to_string(),
        test_status: TestStatus::Completed,
        ..AppState::default()
    }));

    service::import_collection_into_state(&state, sample_collection())
        .expect("import should succeed");

    let app_state = state.lock().expect("state should remain readable");
    assert!(app_state.latest_result.is_none());
    assert!(app_state.latest_finish_reason.is_none());
    assert!(app_state.latest_error_message.is_none());
    assert!(app_state.latest_output.is_empty());
    assert!(matches!(app_state.test_status, TestStatus::Idle));
}

#[test]
fn import_collection_into_state_rejects_busy_runner() {
    let state = Arc::new(Mutex::new(AppState {
        launch_in_progress: true,
        generated_script: Some("existing script".to_string()),
        runtime_collection: Some(empty_runtime_collection()),
        ..AppState::default()
    }));

    let error = service::import_collection_into_state(&state, sample_collection())
        .expect_err("busy state should reject collection import");
    assert!(error.contains("Stop the active k6 test before importing a different collection."));

    let app_state = state.lock().expect("state should remain readable");
    assert_eq!(
        app_state.generated_script.as_deref(),
        Some("existing script")
    );
}
