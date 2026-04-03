use super::import_collection;

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
fn generated_script_supports_weighted_request_selection_and_tags() {
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
        imported
            .script
            .contains("buildWeightedSchedule(runnableRequests, requestWeights)"),
        "expected generated script to build a deterministic weighted schedule when weighted mode is active"
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
