use std::collections::{BTreeMap, BTreeSet};

use crate::models::{K6Options, TrafficMode};

use super::{ResolvedRuntimeRequest, RuntimeCollection, RuntimeRequest};

pub(crate) fn validate_test_run(
    collection: &RuntimeCollection,
    options: &K6Options,
) -> Result<(), String> {
    let selected_requests = select_requests(collection, options)?;
    validate_weighted_selection(&selected_requests, options)?;
    let context = build_runtime_context(collection, options)?;

    selected_requests
        .into_iter()
        .map(|request| resolve_request(request, &context))
        .collect::<Result<Vec<_>, _>>()
        .map(|_| ())
}

pub(crate) fn resolve_test_requests(
    collection: &RuntimeCollection,
    options: &K6Options,
) -> Result<Vec<ResolvedRuntimeRequest>, String> {
    let context = build_runtime_context(collection, options)?;
    let selected_requests = select_requests(collection, options)?;

    selected_requests
        .into_iter()
        .map(|request| resolve_request(request, &context))
        .collect()
}

fn select_requests<'a>(
    collection: &'a RuntimeCollection,
    options: &K6Options,
) -> Result<Vec<&'a RuntimeRequest>, String> {
    if options.selected_request_ids.is_empty() {
        return Err("Select at least one request to run.".to_string());
    }

    let selected_ids: BTreeSet<&str> = options
        .selected_request_ids
        .iter()
        .map(String::as_str)
        .collect();
    let selected_requests: Vec<&RuntimeRequest> = collection
        .requests
        .iter()
        .filter(|request| selected_ids.contains(request.id.as_str()))
        .collect();

    if selected_requests.is_empty() {
        return Err(
            "The selected requests are no longer available in the imported collection.".to_string(),
        );
    }

    Ok(selected_requests)
}

fn validate_weighted_selection(
    selected_requests: &[&RuntimeRequest],
    options: &K6Options,
) -> Result<(), String> {
    if options.traffic_mode != TrafficMode::Weighted {
        return Ok(());
    }

    let has_positive_weight = selected_requests
        .iter()
        .any(|request| effective_request_weight(options, request.id.as_str()) > 0);
    if has_positive_weight {
        return Ok(());
    }

    Err("Weighted mix requires at least one selected request with a positive weight.".to_string())
}

fn effective_request_weight(options: &K6Options, request_id: &str) -> u32 {
    options.request_weights.get(request_id).copied().unwrap_or(1)
}

fn resolve_request(
    request: &RuntimeRequest,
    context: &RuntimeContext,
) -> Result<ResolvedRuntimeRequest, String> {
    if let Some(missing) = first_unresolved_field(&request.headers, context) {
        return Err(format!(
            "Request {:?} still contains unresolved variables in headers: {}",
            request.name,
            missing.join(", ")
        ));
    }

    let resolved_body = if let Some(body) = request.body.as_deref() {
        let (resolved_body, missing) = resolve_template(body, &context.values);
        if !missing.is_empty() {
            return Err(format!(
                "Request {:?} still contains unresolved variables in the body: {}",
                request.name,
                join_keys(&missing)
            ));
        }
        Some(resolved_body)
    } else {
        None
    };

    let (resolved_url, missing_url_variables) = resolve_template(&request.url, &context.values);
    if !missing_url_variables.is_empty() {
        return Err(format!(
            "Request {:?} still contains unresolved variables in the URL: {}",
            request.name,
            join_keys(&missing_url_variables)
        ));
    }

    let effective_url = resolve_url(&resolved_url, context.base_url.as_deref());
    if effective_url.trim().is_empty() {
        return Err(format!(
            "Request {:?} resolved to an empty URL.",
            request.name
        ));
    }

    if let Some(base_url) = context.base_url.as_deref() {
        if !has_http_scheme(base_url) {
            return Err(format!(
                "Base URL must start with http:// or https://, got {:?}.",
                base_url
            ));
        }
    }

    if !has_http_scheme(&effective_url) {
        if looks_like_scheme_url(&effective_url) {
            return Err(format!(
                "Request {:?} resolved to an unsupported URL scheme: {:?}",
                request.name, effective_url
            ));
        }

        return Err(format!(
            "Request {:?} resolved to a relative URL and no valid base URL is configured.",
            request.name
        ));
    }

    Ok(ResolvedRuntimeRequest {
        id: request.id.clone(),
        name: request.name.clone(),
        method: request.method.clone(),
        url: effective_url,
        headers: resolve_headers(&request.headers, context),
        body: resolved_body,
    })
}

fn first_unresolved_field(
    fields: &BTreeMap<String, String>,
    context: &RuntimeContext,
) -> Option<Vec<String>> {
    for value in fields.values() {
        let (_, missing) = resolve_template(value, &context.values);
        if !missing.is_empty() {
            return Some(missing.into_iter().collect());
        }
    }

    None
}

fn resolve_headers(
    headers: &BTreeMap<String, String>,
    context: &RuntimeContext,
) -> BTreeMap<String, String> {
    let mut resolved = BTreeMap::new();

    for (key, value) in headers {
        let (resolved_value, _) = resolve_template(value, &context.values);
        resolved.insert(key.clone(), resolved_value);
    }

    let has_authorization = resolved
        .keys()
        .any(|key| key.eq_ignore_ascii_case("authorization"));
    if !has_authorization && context.auth_token.is_some() {
        resolved.insert(
            "Authorization".to_string(),
            format!(
                "Bearer {}",
                context.auth_token.as_deref().unwrap_or_default()
            ),
        );
    }

    resolved
}

pub(crate) fn build_runtime_context(
    collection: &RuntimeCollection,
    options: &K6Options,
) -> Result<RuntimeContext, String> {
    const HOST_VARIABLE_KEYS: &[&str] = &["baseUrl", "base_url", "environment", "enviroment"];
    let mut values = BTreeMap::new();

    for (key, value) in &collection.variables {
        if HOST_VARIABLE_KEYS.contains(&key.as_str()) {
            continue;
        }

        if let Some(value) = normalize_runtime_value(value) {
            values.insert(key.clone(), value);
        }
    }

    for (key, value) in &options.variable_overrides {
        if HOST_VARIABLE_KEYS.contains(&key.as_str()) {
            continue;
        }

        match normalize_runtime_value(value) {
            Some(value) => {
                values.insert(key.clone(), value);
            }
            None => {
                values.remove(key);
            }
        }
    }

    let configured_base_url = options
        .base_url
        .as_deref()
        .and_then(normalize_runtime_value);
    let base_url = configured_base_url.clone();
    let auth_token = first_non_empty([
        options.auth_token.as_deref(),
        values.get("authToken").map(String::as_str),
        values.get("auth_token").map(String::as_str),
    ])
    .and_then(|value| normalize_auth_token_input(&value));

    if let Some(base_url) = configured_base_url.as_ref() {
        for key in HOST_VARIABLE_KEYS {
            values.insert((*key).to_string(), base_url.clone());
        }
    }
    if let Some(auth_token) = auth_token.as_ref() {
        values.insert("authToken".to_string(), auth_token.clone());
    }

    if let Some(value) = configured_base_url {
        if !has_http_scheme(&value) {
            return Err(format!(
                "Base URL must start with http:// or https://, got {:?}.",
                value
            ));
        }
    }

    Ok(RuntimeContext {
        values,
        base_url,
        auth_token,
    })
}

fn normalize_runtime_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) fn normalize_auth_token_input(value: &str) -> Option<String> {
    let mut normalized = normalize_runtime_value(value)?;

    if normalized
        .get(..14)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("authorization:"))
    {
        normalized = normalized["authorization:".len()..].trim().to_string();
    }

    if normalized
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer "))
    {
        normalized = normalized["bearer ".len()..].trim().to_string();
    }

    normalize_runtime_value(&normalized)
}

fn first_non_empty<const N: usize>(candidates: [Option<&str>; N]) -> Option<String> {
    candidates
        .into_iter()
        .flatten()
        .find_map(normalize_runtime_value)
}

fn resolve_template(value: &str, context: &BTreeMap<String, String>) -> (String, BTreeSet<String>) {
    let mut resolved = String::with_capacity(value.len());
    let mut missing = BTreeSet::new();
    let mut search_index = 0;

    while let Some(start_offset) = value[search_index..].find("{{") {
        let start = search_index + start_offset;
        resolved.push_str(&value[search_index..start]);
        let token_start = start + 2;
        let Some(end_offset) = value[token_start..].find("}}") else {
            resolved.push_str(&value[start..]);
            return (resolved, missing);
        };
        let token_end = token_start + end_offset;
        let key = value[token_start..token_end].trim();
        if let Some(resolved_value) = context.get(key) {
            resolved.push_str(resolved_value);
        } else if !key.is_empty() {
            missing.insert(key.to_string());
        }
        search_index = token_end + 2;
    }

    resolved.push_str(&value[search_index..]);
    (resolved, missing)
}

fn resolve_url(url: &str, base_url: Option<&str>) -> String {
    if url.trim().is_empty() {
        return String::new();
    }

    if has_http_scheme(url) {
        return url.to_string();
    }

    let Some(base_url) = base_url.and_then(normalize_runtime_value) else {
        return url.to_string();
    };

    let base_url = base_url.trim_end_matches('/');
    let suffix = url.trim_start_matches('/');
    format!("{base_url}/{suffix}")
}

fn has_http_scheme(value: &str) -> bool {
    let value = value.trim();
    value.starts_with("http://") || value.starts_with("https://")
}

fn looks_like_scheme_url(value: &str) -> bool {
    let Some(index) = value.find(':') else {
        return false;
    };
    if value[..index].contains('/') {
        return false;
    }

    value[index + 1..].starts_with('/')
}

fn join_keys(keys: &BTreeSet<String>) -> String {
    keys.iter().cloned().collect::<Vec<_>>().join(", ")
}

#[derive(Debug)]
pub(crate) struct RuntimeContext {
    pub(crate) values: BTreeMap<String, String>,
    pub(crate) base_url: Option<String>,
    pub(crate) auth_token: Option<String>,
}
