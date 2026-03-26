mod logic;

use tauri::{AppHandle, State};

use crate::models::{GetTestStatusResponse, K6Options, ValidateTestConfigurationResponse};
use crate::state::SharedAppState;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTestRequest {
    pub options: K6Options,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReportRequest {
    pub save_path: String,
}

#[tauri::command]
pub fn validate_test_configuration(
    state: State<'_, SharedAppState>,
    request: StartTestRequest,
) -> Result<ValidateTestConfigurationResponse, String> {
    Ok(logic::validate_test_configuration_inner(
        state.inner(),
        &request.options,
    ))
}

#[tauri::command]
pub async fn start_test(
    app: AppHandle,
    state: State<'_, SharedAppState>,
    request: StartTestRequest,
) -> Result<(), String> {
    let (script, runtime_collection) = logic::begin_test_start_validation(state.inner())?;

    if let Some(error) =
        logic::validate_test_configuration_for_collection(&runtime_collection, &request.options)
    {
        logic::release_failed_start(state.inner());
        return Err(error);
    }

    let script = logic::finalize_test_start_reservation(state.inner(), &script)?;

    if let Err(error) =
        crate::k6::start_k6_process(app, state.inner().clone(), script, request.options)
    {
        logic::release_failed_start(state.inner());
        return Err(error);
    }

    Ok(())
}

#[tauri::command]
pub async fn stop_test(state: State<'_, SharedAppState>) -> Result<(), String> {
    crate::k6::stop_k6_process(state.inner())?;
    logic::wait_for_test_stop(state.inner())?;
    logic::mark_test_stopped(state.inner())
}

#[tauri::command]
pub async fn export_report(
    state: State<'_, SharedAppState>,
    request: ExportReportRequest,
) -> Result<(), String> {
    let path = crate::k6::export_report_file(state.inner(), &request.save_path)?;
    logic::store_report_path(state.inner(), path)
}

#[tauri::command]
pub fn get_test_status(state: State<'_, SharedAppState>) -> Result<GetTestStatusResponse, String> {
    logic::get_test_status_response(state.inner())
}

#[cfg(test)]
mod tests;
