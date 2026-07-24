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
            .contains("buildWeightedDistribution(runnableRequests, requestWeights)"),
        "expected generated script to build a deterministic cumulative weighted distribution"
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
fn generated_script_does_not_expand_weighted_requests_per_weight_unit() {
    let imported =
        import_collection(sample_host_placeholder_collection()).expect("fixture should import");

    assert!(
        imported.script.contains("let totalWeight = 0;"),
        "expected generated script to track a cumulative total weight"
    );
    assert!(
        imported.script.contains("totalWeight += weight;"),
        "expected generated script to represent weights with cumulative arithmetic"
    );
    assert!(
        imported.script.contains("cumulativeWeight: totalWeight"),
        "expected one cumulative boundary per runnable request"
    );
    assert!(
        !imported.script.contains("index < weight"),
        "expected generated script not to loop once per weight unit"
    );
    assert!(
        !imported.script.contains("schedule.push(request.id)"),
        "expected generated script not to expand request ids into a weighted schedule"
    );
    assert!(
        !imported.script.contains("new Array(weight)"),
        "expected generated script not to allocate an array sized by a request weight"
    );
}

#[test]
fn generated_script_handles_max_u32_weights_without_a_weight_cap_or_expansion() {
    let imported =
        import_collection(sample_host_placeholder_collection()).expect("fixture should import");
    let maximum_u32_weight = f64::from(u32::MAX);

    assert_eq!(
        maximum_u32_weight + maximum_u32_weight,
        8_589_934_590.0,
        "expected two maximum u32 weights to remain exactly representable by JavaScript Number arithmetic"
    );

    assert!(
        imported
            .script
            .contains("return Math.max(0, Math.trunc(rawWeight));"),
        "expected maximum u32 weights to remain numerically represented without clamping"
    );
    assert!(
        imported.script.contains("weightedRequests.push({"),
        "expected generated script to allocate only one distribution entry per runnable request"
    );
    assert!(
        imported
            .script
            .contains("const weightedIndex = iterationIndex % distribution.totalWeight;"),
        "expected exact iteration wrap boundaries to use the cumulative total, including two large weights"
    );
    assert!(
        imported.script.contains("!Number.isFinite(rawWeight)"),
        "expected non-finite runtime weight values to retain the default weight fallback"
    );
    assert!(
        !imported.script.contains("4294967295"),
        "expected generated script not to introduce a hidden maximum-u32 clamp"
    );
}

#[test]
fn generated_script_preserves_weight_defaults_exclusions_and_wrap_boundaries() {
    let imported =
        import_collection(sample_host_placeholder_collection()).expect("fixture should import");

    assert!(
        imported.script.contains("return 1;"),
        "expected missing and non-finite runtime weights to default to one"
    );
    assert!(
        imported.script.contains("if (weight <= 0)"),
        "expected zero-weight requests to be excluded from the cumulative distribution"
    );
    assert!(
        imported
            .script
            .contains("weightedIndex < distribution.weightedRequests[midpoint].cumulativeWeight"),
        "expected exact cumulative boundaries to advance to the next request"
    );
    assert!(
        imported.script.contains(
            "Weighted mix requires at least one selected request with a positive weight."
        ),
        "expected an actionable empty or all-zero weighted-pool failure"
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

#[test]
fn generated_script_disables_redirects_per_request() {
    let imported =
        import_collection(sample_host_placeholder_collection()).expect("fixture should import");

    assert!(
        imported.script.contains("redirects: 0,"),
        "expected each generated k6 request to disable redirects independently of global options"
    );
}
