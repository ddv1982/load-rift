#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::io::{Read, Write};
#[cfg(target_os = "linux")]
use std::net::SocketAddr;
#[cfg(target_os = "linux")]
use std::net::{TcpListener, TcpStream};
#[cfg(target_os = "linux")]
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::process::Command;
#[cfg(target_os = "linux")]
use std::sync::Arc;
#[cfg(target_os = "linux")]
use std::sync::Mutex;
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "linux")]
use std::thread;
#[cfg(target_os = "linux")]
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::{import_collection, runtime, validate_test_run};
use crate::test_support::test_k6_options;

fn imported_test_k6_options(
    imported: &super::ImportedCollection,
    base_url: Option<&str>,
) -> crate::models::K6Options {
    let mut options = test_k6_options(base_url);
    options.selected_request_ids = imported
        .runtime_collection
        .requests
        .iter()
        .map(|request| request.id.clone())
        .collect();
    options
}

fn sample_host_placeholder_collection() -> &'static str {
    r#"{
      "info": {
        "name": "Host Placeholder Fixture",
        "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
      },
      "item": [
        {
          "name": "Lookup alpha",
          "request": {
            "method": "GET",
            "header": [],
            "url": {
              "raw": "{{environment}}/entities/alpha",
              "host": ["{{environment}}"],
              "path": ["entities", "alpha"]
            }
          }
        },
        {
          "name": "Lookup beta",
          "request": {
            "method": "GET",
            "header": [],
            "url": {
              "raw": "{{environment}}/entities/beta",
              "host": ["{{environment}}"],
              "path": ["entities", "beta"]
            }
          }
        }
      ]
    }"#
}

fn sample_host_typo_placeholder_collection() -> &'static str {
    r#"{
      "info": {
        "name": "Host Typo Placeholder Fixture",
        "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
      },
      "item": [
        {
          "name": "Lookup alpha",
          "request": {
            "method": "GET",
            "header": [{ "key": "X-Origin", "value": "{{enviroment}}" }],
            "url": {
              "raw": "{{enviroment}}/entities/alpha",
              "host": ["{{enviroment}}"],
              "path": ["entities", "alpha"]
            }
          }
        }
      ]
    }"#
}

#[test]
fn imports_nested_postman_collections() {
    let imported = import_collection(
        r#"{
          "info": { "name": "Demo Collection" },
          "variable": [{ "key": "baseUrl", "value": "https://api.example.com" }],
          "item": [
            {
              "name": "Folder",
              "item": [
                {
                  "name": "List users",
                  "request": {
                    "method": "GET",
                    "url": { "raw": "{{baseUrl}}/users" }
                  }
                }
              ]
            }
          ]
        }"#,
    )
    .expect("collection should import");

    assert_eq!(imported.info.name, "Demo Collection");
    assert_eq!(imported.info.request_count, 1);
    assert_eq!(imported.info.folder_count, 1);
    assert!(imported.info.requests[0].id.starts_with("request-"));
    assert_eq!(imported.info.requests[0].folder_path, vec!["Folder"]);
    assert!(imported.script.contains("https://api.example.com"));
    assert!(imported.script.contains("List users"));
}

#[test]
fn request_ids_remain_stable_when_an_unrelated_request_is_inserted() {
    let original = import_collection(
        r#"{
          "info": { "name": "Stable ids" },
          "item": [
            {
              "name": "GET account",
              "request": {
                "method": "GET",
                "url": { "raw": "https://api.example.com/account" }
              }
            },
            {
              "name": "GET profile",
              "request": {
                "method": "GET",
                "url": { "raw": "https://api.example.com/profile" }
              }
            }
          ]
        }"#,
    )
    .expect("original collection should import");
    let updated = import_collection(
        r#"{
          "info": { "name": "Stable ids" },
          "item": [
            {
              "name": "GET health",
              "request": {
                "method": "GET",
                "url": { "raw": "https://api.example.com/health" }
              }
            },
            {
              "name": "GET account",
              "request": {
                "method": "GET",
                "url": { "raw": "https://api.example.com/account" }
              }
            },
            {
              "name": "GET profile",
              "request": {
                "method": "GET",
                "url": { "raw": "https://api.example.com/profile" }
              }
            }
          ]
        }"#,
    )
    .expect("updated collection should import");

    let original_account_id = original
        .info
        .requests
        .iter()
        .find(|request| request.name == "GET account")
        .map(|request| request.id.clone())
        .expect("account request should exist in original import");
    let updated_account_id = updated
        .info
        .requests
        .iter()
        .find(|request| request.name == "GET account")
        .map(|request| request.id.clone())
        .expect("account request should exist in updated import");

    assert_eq!(original_account_id, updated_account_id);
}

#[test]
fn duplicate_requests_receive_distinct_stable_ids() {
    let imported = import_collection(
        r#"{
          "info": { "name": "Duplicate ids" },
          "item": [
            {
              "name": "GET profile",
              "request": {
                "method": "GET",
                "url": { "raw": "https://api.example.com/profile" }
              }
            },
            {
              "name": "GET profile",
              "request": {
                "method": "GET",
                "url": { "raw": "https://api.example.com/profile" }
              }
            }
          ]
        }"#,
    )
    .expect("duplicate collection should import");

    assert_eq!(imported.info.requests.len(), 2);
    assert_ne!(imported.info.requests[0].id, imported.info.requests[1].id);
    assert!(imported.info.requests[0].id.starts_with("request-"));
    assert!(imported.info.requests[1].id.starts_with("request-"));
}

#[test]
fn parses_structured_urls_with_host_arrays() {
    let imported = import_collection(
        r#"{
          "info": { "name": "Structured URL Collection" },
          "item": [
            {
              "name": "List users",
              "request": {
                "method": "GET",
                "url": {
                  "protocol": "https",
                  "host": ["api", "example", "com"],
                  "path": ["v1", "users"]
                }
              }
            }
          ]
        }"#,
    )
    .expect("collection should import");

    assert_eq!(
        imported.info.requests[0].url,
        "https://api.example.com/v1/users"
    );
}

#[test]
fn imports_host_placeholder_fixture() {
    let imported =
        import_collection(sample_host_placeholder_collection()).expect("fixture should import");

    assert_eq!(imported.info.name, "Host Placeholder Fixture");
    assert_eq!(imported.info.request_count, 2);
    assert_eq!(imported.info.folder_count, 0);
    assert_eq!(
        imported.info.requests[0].url,
        "{{environment}}/entities/alpha"
    );
    assert_eq!(imported.info.runtime_variables.len(), 1);
    assert_eq!(imported.info.runtime_variables[0].key, "environment");
    assert!(imported.info.runtime_variables[0].default_value.is_none());
    assert!(imported.script.contains("Lookup beta"));
}

#[test]
fn host_placeholder_validation_uses_configured_base_url_without_environment_override() {
    let imported =
        import_collection(sample_host_placeholder_collection()).expect("fixture should import");

    let options = imported_test_k6_options(&imported, Some("https://api.example.com"));

    validate_test_run(&imported.runtime_collection, &options)
        .expect("configured base url should satisfy the missing environment host");
}

#[test]
fn configured_base_url_also_satisfies_environment_placeholders_in_headers() {
    let imported = import_collection(
        r#"{
          "info": { "name": "Header placeholder" },
          "item": [
            {
              "name": "Example",
              "request": {
                "method": "GET",
                "header": [{ "key": "X-Origin", "value": "{{environment}}" }],
                "url": { "raw": "{{environment}}/users" }
              }
            }
          ]
        }"#,
    )
    .expect("fixture should import");

    let options = imported_test_k6_options(&imported, Some("https://api.example.com"));

    validate_test_run(&imported.runtime_collection, &options)
        .expect("configured base url should satisfy environment placeholders consistently");
}

#[test]
fn configured_base_url_also_satisfies_enviroment_placeholders() {
    let imported = import_collection(sample_host_typo_placeholder_collection())
        .expect("fixture should import");

    let options = imported_test_k6_options(&imported, Some("https://api.example.com"));

    validate_test_run(&imported.runtime_collection, &options)
        .expect("configured base url should satisfy enviroment placeholders");
}

#[test]
fn configured_base_url_overrides_host_alias_values_in_runtime_context() {
    let imported =
        import_collection(sample_host_placeholder_collection()).expect("fixture should import");

    let mut options = imported_test_k6_options(&imported, Some("https://derived.example.com"));
    options.variable_overrides.insert(
        "environment".to_string(),
        "https://manual.example.com".to_string(),
    );
    options.variable_overrides.insert(
        "enviroment".to_string(),
        "https://manual-typo.example.com".to_string(),
    );

    let context = runtime::build_runtime_context(&imported.runtime_collection, &options)
        .expect("runtime context should build");

    assert_eq!(
        context.base_url.as_deref(),
        Some("https://derived.example.com")
    );
    assert_eq!(
        context.values.get("environment").map(String::as_str),
        Some("https://derived.example.com")
    );
    assert_eq!(
        context.values.get("enviroment").map(String::as_str),
        Some("https://derived.example.com")
    );
    assert_eq!(
        context.values.get("baseUrl").map(String::as_str),
        Some("https://derived.example.com")
    );
    assert_eq!(
        context.values.get("base_url").map(String::as_str),
        Some("https://derived.example.com")
    );
}

#[test]
fn host_placeholders_do_not_resolve_from_manual_alias_overrides_without_configured_base_url() {
    let imported =
        import_collection(sample_host_placeholder_collection()).expect("fixture should import");

    let mut options = imported_test_k6_options(&imported, None);
    options.variable_overrides.insert(
        "environment".to_string(),
        "https://manual.example.com".to_string(),
    );
    options.variable_overrides.insert(
        "enviroment".to_string(),
        "https://manual-typo.example.com".to_string(),
    );

    let error = validate_test_run(&imported.runtime_collection, &options)
        .expect_err("host aliases should require a configured base url");
    assert!(error.contains("unresolved variables in the URL"));
}

#[test]
fn validation_only_checks_the_selected_request_subset() {
    let imported = import_collection(
        r#"{
          "info": { "name": "Selective validation" },
          "item": [
            {
              "name": "Healthy request",
              "request": {
                "method": "GET",
                "url": { "raw": "https://api.example.com/health" }
              }
            },
            {
              "name": "Broken request",
              "request": {
                "method": "GET",
                "url": { "raw": "{{environment}}/broken" }
              }
            }
          ]
        }"#,
    )
    .expect("fixture should import");

    let mut options = imported_test_k6_options(&imported, Some("https://api.example.com"));
    options.selected_request_ids = vec![imported.info.requests[0].id.clone()];

    validate_test_run(&imported.runtime_collection, &options)
        .expect("validation should only inspect the selected request");
}

#[test]
fn validation_rejects_blank_host_variable_without_base_url_fallback() {
    let imported =
        import_collection(sample_host_placeholder_collection()).expect("fixture should import");

    let mut options = imported_test_k6_options(&imported, None);
    options
        .variable_overrides
        .insert("environment".to_string(), "   ".to_string());

    let error = validate_test_run(&imported.runtime_collection, &options)
        .expect_err("blank environment should not be treated as a valid host");
    assert!(error.contains("relative URL") || error.contains("unresolved variables"));
}

#[test]
fn validation_treats_blank_collection_defaults_as_missing_values() {
    let imported = import_collection(
        r#"{
          "info": { "name": "Blank default" },
          "variable": [{ "key": "environment", "value": "" }],
          "item": [
            {
              "name": "Example",
              "request": {
                "method": "GET",
                "url": { "raw": "{{environment}}/users" }
              }
            }
          ]
        }"#,
    )
    .expect("collection should import");

    let error = validate_test_run(
        &imported.runtime_collection,
        &imported_test_k6_options(&imported, None),
    )
    .expect_err("blank collection defaults should not count as usable values");
    assert!(error.contains("relative URL") || error.contains("unresolved variables"));
}

#[test]
fn normalizes_bearer_token_inputs() {
    assert_eq!(
        runtime::normalize_auth_token_input("Authorization: Bearer integration-token"),
        Some("integration-token".to_string())
    );
    assert_eq!(
        runtime::normalize_auth_token_input("Bearer integration-token"),
        Some("integration-token".to_string())
    );
    assert_eq!(
        runtime::normalize_auth_token_input("integration-token"),
        Some("integration-token".to_string())
    );
    assert_eq!(runtime::normalize_auth_token_input("   "), None);
}

#[cfg(target_os = "linux")]
#[test]
fn host_placeholder_generated_script_runs_with_bundled_k6() {
    let imported =
        import_collection(sample_host_placeholder_collection()).expect("fixture should import");

    let Some((summary_json, requests)) = run_generated_script_fixture(
        &imported.script,
        "loadrift-test",
        Some("Authorization: Bearer integration-token"),
    ) else {
        return;
    };

    assert!(summary_json.contains("\"http_reqs\""));
    assert!(summary_json.contains("\"http_req_failed\""));

    assert!(
        requests
            .iter()
            .any(|request| request.starts_with("GET /entities/")),
        "expected a generated fixture request path, captured requests: {requests:?}"
    );
    assert!(
        requests
            .iter()
            .any(|request| { request.contains("Authorization: Bearer integration-token") }),
        "expected the injected bearer token header, captured requests: {requests:?}"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn enviroment_placeholder_generated_script_runs_with_bundled_k6() {
    let imported = import_collection(sample_host_typo_placeholder_collection())
        .expect("fixture should import");

    let Some((summary_json, requests)) =
        run_generated_script_fixture(&imported.script, "loadrift-enviroment", None)
    else {
        return;
    };

    assert!(summary_json.contains("\"http_reqs\""));

    assert!(
        requests
            .iter()
            .any(|request| request.starts_with("GET /entities/")),
        "expected a generated fixture request path, captured requests: {requests:?}"
    );
}

#[cfg(target_os = "linux")]
fn run_generated_script_fixture(
    script: &str,
    file_prefix: &str,
    auth_token: Option<&str>,
) -> Option<(String, Vec<String>)> {
    let k6_binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join(k6_binary_name());
    if !k6_binary.is_file() {
        eprintln!(
            "Skipping k6 execution test because {} is missing.",
            k6_binary.display()
        );
        return None;
    }

    let server = CapturingServer::start();
    let script_path = temp_artifact_path(file_prefix, "js");
    let summary_path = temp_artifact_path(file_prefix, "json");
    fs::write(&script_path, script).expect("script should be written");

    let mut command = Command::new(&k6_binary);
    command
        .arg("run")
        .arg("--summary-export")
        .arg(&summary_path)
        .arg(&script_path)
        .env("K6_NO_COLOR", "true")
        .env("K6_WEB_DASHBOARD", "false")
        .env("K6_VUS", "1")
        .env("K6_DURATION", "1s")
        .env("K6_RAMP_UP", "instant")
        .env("BASE_URL", format!("http://{}", server.address));

    if let Some(auth_token) = auth_token {
        command.env("AUTH_TOKEN", auth_token);
    }

    let output = command.output().expect("k6 should run");
    let requests = server.finish();

    let _ = fs::remove_file(&script_path);
    let summary_json = fs::read_to_string(&summary_path).expect("k6 should write the summary file");
    let _ = fs::remove_file(&summary_path);

    assert!(
        output.status.success(),
        "k6 execution failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    Some((summary_json, requests))
}

#[cfg(target_os = "linux")]
struct CapturingServer {
    address: SocketAddr,
    captured_requests: Arc<Mutex<Vec<String>>>,
    stop_server: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

#[cfg(target_os = "linux")]
impl CapturingServer {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        listener
            .set_nonblocking(true)
            .expect("listener should become non-blocking");
        let address = listener
            .local_addr()
            .expect("listener should expose its address");

        let stop_server = Arc::new(AtomicBool::new(false));
        let server_stop_flag = stop_server.clone();
        let captured_requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let captured_request_log = captured_requests.clone();
        let handle = thread::spawn(move || {
            while !server_stop_flag.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut buffer = [0_u8; 4096];
                        let bytes_read = stream.read(&mut buffer).unwrap_or(0);
                        if let Ok(mut requests) = captured_request_log.lock() {
                            requests.push(String::from_utf8_lossy(&buffer[..bytes_read]).into());
                        }
                        let response =
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK";
                        let _ = stream.write_all(response);
                        let _ = stream.flush();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });

        Self {
            address,
            captured_requests,
            stop_server,
            handle: Some(handle),
        }
    }

    fn finish(mut self) -> Vec<String> {
        self.stop_server.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.address);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }

        self.captured_requests
            .lock()
            .expect("captured requests should remain readable")
            .clone()
    }
}

#[cfg(target_os = "linux")]
fn temp_artifact_path(prefix: &str, extension: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time should be monotonic enough for test temp files")
        .as_nanos();
    std::env::temp_dir().join(format!("{prefix}-{nonce}.{extension}"))
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn k6_binary_name() -> &'static str {
    "k6-x86_64-unknown-linux-gnu"
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn k6_binary_name() -> &'static str {
    "k6-aarch64-unknown-linux-gnu"
}
