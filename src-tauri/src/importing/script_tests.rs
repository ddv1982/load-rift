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
        imported.script.contains(r#"import exec from "k6/execution";"#),
        "expected generated script to import k6 execution helpers"
    );
    assert!(
        imported.script.contains("abortForAuthorizationFailure(response, request);"),
        "expected generated script to check for authorization failures"
    );
    assert!(
        imported.script.contains("response.status === 401 || response.status === 403"),
        "expected generated script to abort on 401/403 responses"
    );
    assert!(
        imported.script.contains("exec.test.abort"),
        "expected generated script to abort the full test on authorization failure"
    );
}
