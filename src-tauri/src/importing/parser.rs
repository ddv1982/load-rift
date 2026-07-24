use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use uuid::Uuid;

use super::{ParsedCollection, RuntimeRequest};

const REQUEST_ID_NAMESPACE: Uuid = Uuid::from_bytes([
    0xa4, 0xc6, 0x44, 0x83, 0x70, 0x89, 0x5c, 0xd1, 0x88, 0xc0, 0xa0, 0xfb, 0xe6, 0x9d, 0xe4, 0x9e,
]);

pub(crate) fn parse_collection(content: &str) -> Result<ParsedCollection, String> {
    let root: Value =
        serde_json::from_str(content).map_err(|error| format!("Invalid JSON: {error}"))?;
    let collection_node = root.get("collection").unwrap_or(&root);

    let items = collection_node
        .get("item")
        .and_then(Value::as_array)
        .ok_or("The JSON payload does not look like a Postman collection.".to_string())?;

    let variables = extract_variables(collection_node);
    let mut runtime_variable_keys = BTreeSet::new();
    runtime_variable_keys.extend(variables.keys().cloned());
    for value in variables.values() {
        runtime_variable_keys.extend(extract_template_keys(value));
    }

    let mut parsed = ParsedCollection {
        name: collection_node
            .get("info")
            .and_then(|info| info.get("name"))
            .and_then(Value::as_str)
            .or_else(|| collection_node.get("name").and_then(Value::as_str))
            .unwrap_or("Imported Collection")
            .to_string(),
        folder_count: 0,
        variables,
        runtime_variable_keys,
        requests: Vec::new(),
    };

    let mut folder_path = Vec::new();
    let mut fingerprint_counts = BTreeMap::new();
    for item in items {
        collect_item(item, &mut parsed, &mut folder_path, &mut fingerprint_counts)?;
    }

    if parsed.requests.is_empty() {
        return Err("The collection did not contain any runnable requests.".to_string());
    }

    Ok(parsed)
}

fn extract_variables(node: &Value) -> BTreeMap<String, String> {
    let mut variables = BTreeMap::new();

    let Some(entries) = node.get("variable").and_then(Value::as_array) else {
        return variables;
    };

    for entry in entries {
        let disabled = entry
            .get("disabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if disabled {
            continue;
        }

        let Some(key) = entry.get("key").and_then(Value::as_str) else {
            continue;
        };

        let value = entry
            .get("value")
            .and_then(value_to_string)
            .unwrap_or_default();
        variables.insert(key.to_string(), value);
    }

    variables
}

fn collect_item(
    item: &Value,
    parsed: &mut ParsedCollection,
    folder_path: &mut Vec<String>,
    fingerprint_counts: &mut BTreeMap<String, usize>,
) -> Result<(), String> {
    if let Some(children) = item.get("item").and_then(Value::as_array) {
        parsed.folder_count += 1;
        let folder_name = item
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("Folder {}", parsed.folder_count));
        folder_path.push(folder_name);
        let result = children
            .iter()
            .try_for_each(|child| collect_item(child, parsed, folder_path, fingerprint_counts));
        folder_path.pop();
        return result;
    }

    let Some(request) = item.get("request") else {
        return Ok(());
    };

    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .to_uppercase();
    let (url, url_encoded_variable_occurrences) = parse_url(request.get("url"));
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("{method} {url}"));
    parsed
        .runtime_variable_keys
        .extend(extract_template_keys(&url));
    let mut headers = parse_headers(request.get("header"));
    for value in headers.values() {
        parsed
            .runtime_variable_keys
            .extend(extract_template_keys(value));
    }
    let (body, encode_body_variable_values) = parse_body(request.get("body"), &name)?;
    let is_urlencoded_body = body.is_some()
        && request
            .get("body")
            .and_then(|body| body.get("mode"))
            .and_then(Value::as_str)
            == Some("urlencoded");
    if is_urlencoded_body
        && !headers
            .keys()
            .any(|key| key.eq_ignore_ascii_case("content-type"))
    {
        headers.insert(
            "Content-Type".to_string(),
            "application/x-www-form-urlencoded".to_string(),
        );
    }
    if let Some(body) = body.as_deref() {
        parsed
            .runtime_variable_keys
            .extend(extract_template_keys(body));
    }

    let request_id = build_request_id(
        folder_path,
        &name,
        &method,
        &url,
        &headers,
        body.as_deref(),
        fingerprint_counts,
    );
    parsed.requests.push(RuntimeRequest {
        id: request_id,
        name,
        method,
        url,
        folder_path: folder_path.clone(),
        headers,
        body,
        url_encoded_variable_occurrences,
        encode_body_variable_values,
    });
    Ok(())
}

fn build_request_id(
    folder_path: &[String],
    name: &str,
    method: &str,
    url: &str,
    headers: &BTreeMap<String, String>,
    body: Option<&str>,
    fingerprint_counts: &mut BTreeMap<String, usize>,
) -> String {
    let fingerprint = serde_json::json!({
        "folderPath": folder_path,
        "name": name,
        "method": method,
        "url": url,
        "headers": headers,
        "body": body,
    })
    .to_string();
    let fingerprint_hash = Uuid::new_v5(&REQUEST_ID_NAMESPACE, fingerprint.as_bytes()).to_string();
    let occurrence = fingerprint_counts
        .entry(fingerprint_hash.clone())
        .and_modify(|count| *count += 1)
        .or_insert(1);

    if *occurrence == 1 {
        format!("request-{fingerprint_hash}")
    } else {
        format!("request-{fingerprint_hash}-{occurrence}")
    }
}

fn parse_url(url: Option<&Value>) -> (String, Vec<usize>) {
    let Some(url) = url else {
        return (String::new(), Vec::new());
    };

    if let Some(raw) = url.as_str() {
        return (raw.to_string(), Vec::new());
    }

    if let Some(raw) = url.get("raw").and_then(Value::as_str) {
        return (raw.to_string(), Vec::new());
    }

    let protocol = url
        .get("protocol")
        .and_then(Value::as_str)
        .map(|value| format!("{value}://"))
        .unwrap_or_default();
    let host = join_segments(url.get("host"), ".");
    let path = join_segments(url.get("path"), "/");

    let mut parsed_url = format!("{protocol}{host}");
    if !path.is_empty() {
        if !parsed_url.ends_with('/') && !path.starts_with('/') {
            parsed_url.push('/');
        }
        parsed_url.push_str(&path);
    }

    let mut template_occurrence_index = template_occurrence_count(&parsed_url);
    let mut url_encoded_variable_occurrences = Vec::new();
    let query = url
        .get("query")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter(|entry| {
                    !entry
                        .get("disabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .filter_map(|entry| {
                    let key = entry.get("key").and_then(Value::as_str)?;
                    let value = entry
                        .get("value")
                        .and_then(value_to_string)
                        .unwrap_or_default();
                    let encoded_key = percent_encode_component(key);
                    url_encoded_variable_occurrences.extend(
                        encoded_component_template_occurrences(
                            &encoded_key,
                            template_occurrence_index,
                        ),
                    );
                    template_occurrence_index += template_occurrence_count(&encoded_key);

                    let encoded_value = percent_encode_component(&value);
                    url_encoded_variable_occurrences.extend(
                        encoded_component_template_occurrences(
                            &encoded_value,
                            template_occurrence_index,
                        ),
                    );
                    template_occurrence_index += template_occurrence_count(&encoded_value);

                    Some(format!("{encoded_key}={encoded_value}"))
                })
                .collect::<Vec<_>>()
                .join("&")
        })
        .filter(|value| !value.is_empty())
        .map(|value| format!("?{value}"))
        .unwrap_or_default();

    parsed_url.push_str(&query);
    (parsed_url, url_encoded_variable_occurrences)
}

fn template_occurrence_count(value: &str) -> usize {
    let mut count = 0;
    let mut search_index = 0;

    while let Some(start_offset) = value[search_index..].find("{{") {
        let token_start = search_index + start_offset + 2;
        let Some(end_offset) = value[token_start..].find("}}") else {
            break;
        };
        count += 1;
        search_index = token_start + end_offset + 2;
    }

    count
}

fn encoded_component_template_occurrences(
    encoded_component: &str,
    starting_index: usize,
) -> Vec<usize> {
    let mut occurrences = Vec::new();
    let mut occurrence_index = starting_index;
    let mut search_index = 0;

    while let Some(start_offset) = encoded_component[search_index..].find("{{") {
        let token_start = search_index + start_offset + 2;
        let Some(end_offset) = encoded_component[token_start..].find("}}") else {
            break;
        };
        occurrences.push(occurrence_index);
        occurrence_index += 1;
        search_index = token_start + end_offset + 2;
    }

    occurrences
}

fn percent_encode_component(value: &str) -> String {
    let mut encoded = String::new();
    let mut search_index = 0;

    while let Some(start_offset) = value[search_index..].find("{{") {
        let start = search_index + start_offset;
        encode_plain_component(&value[search_index..start], &mut encoded);

        let Some(end_offset) = value[start + 2..].find("}}") else {
            encode_plain_component(&value[start..], &mut encoded);
            return encoded;
        };
        let end = start + 2 + end_offset + 2;
        encoded.push_str(&value[start..end]);
        search_index = end;
    }

    encode_plain_component(&value[search_index..], &mut encoded);
    encoded
}

fn encode_plain_component(value: &str, encoded: &mut String) {
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
}

fn join_segments(value: Option<&Value>, delimiter: &str) -> String {
    match value {
        Some(Value::Array(entries)) => entries
            .iter()
            .filter_map(value_to_string)
            .collect::<Vec<_>>()
            .join(delimiter),
        Some(other) => value_to_string(other).unwrap_or_default(),
        None => String::new(),
    }
}

fn parse_headers(headers: Option<&Value>) -> BTreeMap<String, String> {
    let mut parsed = BTreeMap::new();

    let Some(headers) = headers.and_then(Value::as_array) else {
        return parsed;
    };

    for header in headers {
        let disabled = header
            .get("disabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if disabled {
            continue;
        }

        let Some(key) = header.get("key").and_then(Value::as_str) else {
            continue;
        };

        let value = header
            .get("value")
            .and_then(value_to_string)
            .unwrap_or_default();
        parsed.insert(key.to_string(), value);
    }

    parsed
}

fn parse_body(body: Option<&Value>, request_name: &str) -> Result<(Option<String>, bool), String> {
    let Some(body) = body else {
        return Ok((None, false));
    };
    let disabled = body
        .get("disabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if disabled {
        return Ok((None, false));
    }

    match body.get("mode").and_then(Value::as_str) {
        Some("raw") => {
            let raw = body.get("raw").and_then(value_to_string).ok_or_else(|| {
                format!(
                    "Request '{request_name}' body mode 'raw' requires a non-null 'raw' payload."
                )
            })?;
            Ok((Some(raw), false))
        }
        Some("urlencoded") => {
            let Some(entries) = body.get("urlencoded").and_then(Value::as_array) else {
                return Err(format!(
                    "Request '{request_name}' body mode 'urlencoded' requires 'urlencoded' to be an array."
                ));
            };
            let mut encoded_entries = Vec::with_capacity(entries.len());
            for (index, entry) in entries.iter().enumerate() {
                if entry
                    .get("disabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    continue;
                }
                if entry.get("type").and_then(Value::as_str) == Some("file") {
                    return Err(format!(
                        "Request '{request_name}' body mode 'urlencoded' contains an unsupported file part at entry {index}."
                    ));
                }
                let key = entry.get("key").and_then(Value::as_str).ok_or_else(|| {
                    format!(
                        "Request '{request_name}' body mode 'urlencoded' has a malformed entry at index {index}: expected a string 'key'."
                    )
                })?;
                let value = entry
                    .get("value")
                    .and_then(value_to_string)
                    .unwrap_or_default();
                encoded_entries.push(format!(
                    "{}={}",
                    percent_encode_component(key),
                    percent_encode_component(&value)
                ));
            }
            Ok((Some(encoded_entries.join("&")), true))
        }
        Some("formdata") => {
            let Some(entries) = body.get("formdata").and_then(Value::as_array) else {
                return Err(format!(
                    "Request '{request_name}' body mode 'formdata' requires 'formdata' to be an array."
                ));
            };
            if let Some((index, _)) = entries.iter().enumerate().find(|(_, entry)| {
                !entry
                    .get("disabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    && entry.get("type").and_then(Value::as_str) == Some("file")
            }) {
                return Err(format!(
                    "Request '{request_name}' body mode 'formdata' contains an unsupported file part at entry {index}."
                ));
            }
            Err(format!(
                "Request '{request_name}' body mode 'formdata' is unsupported because multipart form-data semantics and content type cannot be preserved."
            ))
        }
        Some("file") => Err(format!(
            "Request '{request_name}' body mode 'file' is unsupported because file bodies cannot be preserved."
        )),
        Some("graphql") => Err(format!(
            "Request '{request_name}' body mode 'graphql' is unsupported."
        )),
        Some(mode) if mode.contains("multipart") => Err(format!(
            "Request '{request_name}' body mode '{mode}' is unsupported because multipart semantics and content type cannot be preserved."
        )),
        Some(mode) => Err(format!(
            "Request '{request_name}' has unsupported body mode '{mode}'; supported body modes are 'raw' and 'urlencoded'."
        )),
        None => Err(format!(
            "Request '{request_name}' has an enabled body without a valid string mode; supported body modes are 'raw' and 'urlencoded'."
        )),
    }
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        other => Some(other.to_string()),
    }
}

pub(crate) fn extract_template_keys(value: &str) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    let mut search_index = 0;

    while let Some(start_offset) = value[search_index..].find("{{") {
        let start = search_index + start_offset + 2;
        let Some(end_offset) = value[start..].find("}}") else {
            break;
        };
        let end = start + end_offset;
        let candidate = value[start..end].trim();
        if !candidate.is_empty() {
            keys.insert(candidate.to_string());
        }
        search_index = end + 2;
    }

    keys
}
