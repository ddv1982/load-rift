use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::models::{CollectionInfo, K6Options, RequestInfo, RuntimeVariable};

mod parser;
mod runtime;
mod script;

#[derive(Debug)]
pub struct ImportedCollection {
    pub info: CollectionInfo,
    pub script: String,
    pub runtime_collection: RuntimeCollection,
}

#[derive(Debug, Clone)]
pub struct RuntimeCollection {
    pub variables: BTreeMap<String, String>,
    pub requests: Vec<RuntimeRequest>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeRequest {
    pub id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    pub folder_path: Vec<String>,
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedRuntimeRequest {
    pub id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
}

#[derive(Debug)]
pub(crate) struct ParsedCollection {
    pub(crate) name: String,
    pub(crate) folder_count: usize,
    pub(crate) variables: BTreeMap<String, String>,
    pub(crate) runtime_variable_keys: BTreeSet<String>,
    pub(crate) requests: Vec<RuntimeRequest>,
}

pub fn import_collection(content: &str) -> Result<ImportedCollection, String> {
    let parsed = parser::parse_collection(content)?;

    let info = CollectionInfo {
        name: parsed.name.clone(),
        request_count: parsed.requests.len(),
        folder_count: parsed.folder_count,
        requests: parsed
            .requests
            .iter()
            .map(|request| RequestInfo {
                id: request.id.clone(),
                name: request.name.clone(),
                method: request.method.clone(),
                url: request.url.clone(),
                folder_path: request.folder_path.clone(),
            })
            .collect(),
        runtime_variables: parsed
            .runtime_variable_keys
            .iter()
            .map(|key| RuntimeVariable {
                key: key.clone(),
                default_value: parsed.variables.get(key).cloned(),
            })
            .collect(),
    };

    let script = script::generate_k6_script(&parsed)?;
    let runtime_collection = RuntimeCollection {
        variables: parsed.variables.clone(),
        requests: parsed.requests.clone(),
    };

    Ok(ImportedCollection {
        info,
        script,
        runtime_collection,
    })
}

pub fn validate_test_run(
    collection: &RuntimeCollection,
    options: &K6Options,
) -> Result<(), String> {
    runtime::validate_test_run(collection, options)
}

pub fn resolve_test_requests(
    collection: &RuntimeCollection,
    options: &K6Options,
) -> Result<Vec<ResolvedRuntimeRequest>, String> {
    runtime::resolve_test_requests(collection, options)
}

#[cfg(test)]
mod script_tests;

#[cfg(test)]
mod tests;
