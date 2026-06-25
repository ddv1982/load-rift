use std::fs;
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

#[test]
fn import_collection_from_path_checks_busy_before_reading_file() {
    let state = Arc::new(Mutex::new(AppState {
        launch_in_progress: true,
        ..AppState::default()
    }));

    let error = super::import_collection_from_path(&state, "/definitely/missing/load-rift.json")
        .expect_err("busy state should reject before file IO");

    assert!(error.contains("Stop the active k6 test before importing a different collection."));
    assert!(!error.contains("Failed to read"));
}

#[test]
fn import_collection_from_path_rejects_non_json_file() {
    let state = Arc::new(Mutex::new(AppState::default()));
    let temp_dir = tempfile::tempdir().expect("temp dir should be created");
    let path = temp_dir.path().join("collection.txt");
    fs::write(&path, sample_collection()).expect("fixture should be written");

    let error = super::import_collection_from_path(&state, path.to_str().unwrap())
        .expect_err("non-json imports should fail");

    assert!(error.contains(".json extension"));
}

#[test]
fn import_collection_from_path_rejects_large_files_before_reading() {
    let state = Arc::new(Mutex::new(AppState::default()));
    let temp_dir = tempfile::tempdir().expect("temp dir should be created");
    let path = temp_dir.path().join("collection.json");
    let file = fs::File::create(&path).expect("fixture should be created");
    file.set_len(super::MAX_COLLECTION_FILE_BYTES + 1)
        .expect("fixture should be resized");

    let error = super::import_collection_from_path(&state, path.to_str().unwrap())
        .expect_err("oversized imports should fail");

    assert!(error.contains("too large"));
}

#[test]
fn import_collection_into_state_checks_busy_before_parsing() {
    let state = Arc::new(Mutex::new(AppState {
        launch_in_progress: true,
        ..AppState::default()
    }));

    let error = service::import_collection_into_state(&state, "not valid json")
        .expect_err("busy state should reject before parsing");

    assert!(error.contains("Stop the active k6 test before importing a different collection."));
    assert!(!error.contains("Invalid JSON"));
}
