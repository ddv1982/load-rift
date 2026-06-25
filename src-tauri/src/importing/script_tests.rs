use super::import_collection;

fn sample_structured_query_template_collection() -> &'static str {
    r#"{
      "info": {
        "name": "Structured Query Fixture",
        "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
      },
      "item": [
        {
          "name": "Search",
          "request": {
            "method": "GET",
            "header": [],
            "url": {
              "protocol": "https",
              "host": ["api", "example", "com"],
              "path": ["über"],
              "query": [{ "key": "q", "value": "{{term}}" }]
            }
          }
        }
      ]
    }"#
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
        }
      ]
    }"#
}

#[test]
fn generated_script_aborts_the_test_on_authorization_failures() {
    let imported =
        import_collection(sample_host_placeholder_collection()).expect("fixture should import");

    assert!(
        imported
            .script
            .contains(r#"import exec from "k6/execution";"#),
        "expected generated script to import k6 execution helpers"
    );
    assert!(
        imported
            .script
            .contains("abortForAuthorizationFailure(response, request);"),
        "expected generated script to check for authorization failures"
    );
    assert!(
        imported
            .script
            .contains("response.status === 401 || response.status === 403"),
        "expected generated script to abort on 401/403 responses"
    );
    assert!(
        imported.script.contains("exec.test.abort"),
        "expected generated script to abort the full test on authorization failure"
    );
}

#[test]
fn generated_script_uses_occurrence_metadata_and_rfc3986_encoding() {
    let imported = import_collection(sample_structured_query_template_collection())
        .expect("fixture should import");

    assert!(
        imported.script.contains("urlEncodedVariableOccurrences"),
        "expected generated request JSON to carry encoded variable occurrence metadata"
    );
    assert!(
        imported
            .script
            .contains("encodedVariableOccurrences: request.urlEncodedVariableOccurrences || []"),
        "expected generated URL resolution to use occurrence metadata"
    );
    assert!(
        imported
            .script
            .contains("function encodeRfc3986Component(value)"),
        "expected generated script to define a strict RFC3986 encoder"
    );
    assert!(
        imported.script.contains("replace(/[!'()*]/g"),
        "expected generated script to escape RFC3986 reserved sub-delims left raw by encodeURIComponent"
    );
    assert!(
        !imported.script.contains("encodeVariablesFrom"),
        "expected generated script to avoid offset-based encoding metadata"
    );
    assert!(
        !imported.script.contains("urlVariableEncodingStart"),
        "expected generated request JSON to avoid byte-offset metadata"
    );
}

#[test]
fn generated_script_supports_weighted_request_scheduling_and_tags() {
    let imported =
        import_collection(sample_host_placeholder_collection()).expect("fixture should import");

    assert!(
        imported.script.contains(r#"LOADRIFT_REQUEST_WEIGHTS_JSON"#),
        "expected generated script to parse request weights from the runtime environment"
    );
    assert!(
        imported.script.contains(r#"request_id: request.id"#),
        "expected generated script to tag requests with a stable request id"
    );
    assert!(
        imported.script.contains(r#"traffic_mode: trafficMode"#),
        "expected generated script to tag requests with the active traffic mode"
    );
    assert!(
        imported.script.contains("REQUESTS_BY_ID"),
        "expected generated script to build a constant-time request lookup map"
    );
    assert!(
        imported
            .script
            .contains("buildWeightedSchedule(runnableRequests, requestWeights)"),
        "expected generated script to build a deterministic weighted schedule"
    );
    assert!(
        imported.script.contains("exec.scenario.iterationInTest"),
        "expected generated script to derive weighted picks from the scenario iteration index"
    );
    assert!(
        !imported.script.contains("Math.random()"),
        "expected generated script to avoid probabilistic random weighted selection"
    );
}

#[test]
fn generated_script_supports_runtime_headers_and_body_override() {
    let imported =
        import_collection(sample_host_placeholder_collection()).expect("fixture should import");

    assert!(
        imported.script.contains("LOADRIFT_REQUEST_HEADERS_JSON"),
        "expected generated script to parse runtime request headers"
    );
    assert!(
        imported
            .script
            .contains("LOADRIFT_REQUEST_BODY_OVERRIDE_JSON"),
        "expected generated script to parse a request-scoped body override"
    );
    assert!(
        imported.script.contains("insertHeaderCaseInsensitive"),
        "expected generated script to merge runtime headers case-insensitively"
    );
    assert!(
        imported.script.contains("function resolveRequestBody"),
        "expected generated script to resolve a request-scoped body override"
    );
    assert!(
        imported
            .script
            .contains("requestHeaders, requestBodyOverride"),
        "expected generated script to pass runtime request details into execution"
    );
}
