use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::service;
use crate::models::TestStatus;
use crate::state::AppState;
use crate::test_support::{empty_runtime_collection, passed_result};
use tauri_plugin_http::reqwest;

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
    assert_eq!(
        app_state.collection_name.as_deref(),
        Some("Demo Collection")
    );
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
        report_path: Some("/tmp/old-report.html".into()),
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
    assert!(app_state.report_path.is_none());
    assert!(matches!(app_state.test_status, TestStatus::Idle));
}

#[test]
fn import_collection_into_state_rejects_busy_runner() {
    let state = Arc::new(Mutex::new(AppState {
        launch_in_progress: true,
        collection_name: Some("Existing Collection".to_string()),
        generated_script: Some("existing script".to_string()),
        runtime_collection: Some(empty_runtime_collection()),
        ..AppState::default()
    }));

    let error = service::import_collection_into_state(&state, sample_collection())
        .expect_err("busy state should reject collection import");
    assert!(error.contains("Stop the active k6 test before importing a different collection."));

    let app_state = state.lock().expect("state should remain readable");
    assert_eq!(
        app_state.collection_name.as_deref(),
        Some("Existing Collection")
    );
    assert_eq!(
        app_state.generated_script.as_deref(),
        Some("existing script")
    );
}

#[test]
fn fetch_url_content_rejects_non_http_urls() {
    let error =
        tauri::async_runtime::block_on(service::fetch_url_content("file:///tmp/collection.json"))
            .expect_err("non-http scheme should be rejected");
    assert_eq!(error, "Collection URL must start with http:// or https://.");
}

#[test]
fn fetch_url_content_rejects_oversized_responses() {
    let server_url = spawn_http_test_server(|mut stream| {
        let body = "x".repeat(32);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream
            .write_all(response.as_bytes())
            .expect("response should be written");
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .expect("client should build");

    let error = tauri::async_runtime::block_on(service::fetch_url_content_with_client(
        &client,
        &server_url,
        16,
    ))
    .expect_err("oversized responses should be rejected");

    assert_eq!(
        error,
        "Collection download exceeded the 5 MB response limit."
    );
}

#[test]
fn fetch_url_content_times_out_slow_servers() {
    let server_url = spawn_http_test_server(|_stream| {
        thread::sleep(Duration::from_millis(200));
    });
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(50))
        .timeout(Duration::from_millis(50))
        .build()
        .expect("client should build");

    let started_at = Instant::now();
    let error = tauri::async_runtime::block_on(service::fetch_url_content_with_client(
        &client,
        &server_url,
        1024,
    ))
    .expect_err("slow servers should time out");

    assert!(error.contains("Failed to fetch"));
    assert!(
        started_at.elapsed() < Duration::from_millis(175),
        "slow server fetch should fail fast, got error: {error}"
    );
}

fn spawn_http_test_server(handler: impl FnOnce(TcpStream) + Send + 'static) -> String {
    let listener =
        TcpListener::bind("127.0.0.1:0").expect("test HTTP server should bind to localhost");
    let address = listener
        .local_addr()
        .expect("listener should expose the bound address");

    thread::spawn(move || {
        let (mut stream, _) = listener
            .accept()
            .expect("test HTTP server should accept a connection");
        let mut request = [0_u8; 1024];
        let _ = stream.read(&mut request);
        handler(stream);
    });

    format!("http://{address}/collection.json")
}
