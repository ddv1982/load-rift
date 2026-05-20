mod logic;
mod smoke;

use tauri::{AppHandle, State};

use crate::importing::resolve_test_requests;
use crate::models::{
    GetTestStatusResponse, K6Options, SmokeTestResponse, StartTestResponse,
    ValidateTestConfigurationResponse,
};
use crate::state::SharedAppState;
use uuid::Uuid;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTestRequest {
    pub options: K6Options,
    pub run_id: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReportRequest {
    pub save_path: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeTestRequest {
    pub options: K6Options,
}

#[tauri::command]
pub fn validate_test_configuration(
    state: State<'_, SharedAppState>,
    request: StartTestRequest,
) -> ValidateTestConfigurationResponse {
    logic::validate_test_configuration_inner(state.inner(), &request.options)
}

#[tauri::command]
pub async fn start_test(
    app: AppHandle,
    state: State<'_, SharedAppState>,
    request: StartTestRequest,
) -> Result<StartTestResponse, String> {
    let run_id = request
        .run_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let (script, runtime_collection) = logic::begin_test_start_validation(state.inner(), &run_id)?;

    if let Some(error) =
        logic::validate_test_configuration_for_collection(&runtime_collection, &request.options)
    {
        logic::release_failed_start(state.inner(), &run_id);
        return Err(error);
    }

    let script = logic::finalize_test_start_reservation(state.inner(), &script, &run_id)?;

    if let Err(error) = crate::k6::start_k6_process(
        app,
        state.inner().clone(),
        script,
        request.options,
        run_id.clone(),
    ) {
        logic::release_failed_start(state.inner(), &run_id);
        return Err(error);
    }

    Ok(StartTestResponse { run_id })
}

#[tauri::command]
pub async fn stop_test(state: State<'_, SharedAppState>) -> Result<(), String> {
    let run_id = crate::k6::stop_k6_process(state.inner())?;
    logic::wait_for_test_stop(state.inner())?;
    if let Ok(mut app_state) = state.inner().lock() {
        if app_state.latest_run_id.as_deref() == Some(&run_id) && !app_state.test_is_busy() {
            app_state.test_status = crate::models::TestStatus::Stopped;
        }
        return Ok(());
    }

    Err("Failed to update the shared Tauri app state.".to_string())
}

#[tauri::command]
pub async fn smoke_test_requests(
    state: State<'_, SharedAppState>,
    request: SmokeTestRequest,
) -> Result<SmokeTestResponse, String> {
    let runtime_collection = logic::runtime_collection_for_smoke_test(state.inner())?;
    let resolved_requests = resolve_test_requests(&runtime_collection, &request.options)?;

    tauri::async_runtime::spawn_blocking(move || smoke::run_smoke_test(resolved_requests))
        .await
        .map_err(|error| format!("Smoke test task failed unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn export_report(
    state: State<'_, SharedAppState>,
    request: ExportReportRequest,
) -> Result<(), String> {
    crate::k6::export_report_file(state.inner(), &request.save_path)?;
    Ok(())
}

#[tauri::command]
pub fn get_test_status(state: State<'_, SharedAppState>) -> Result<GetTestStatusResponse, String> {
    logic::get_test_status_response(state.inner())
}

#[cfg(test)]
mod tests;
