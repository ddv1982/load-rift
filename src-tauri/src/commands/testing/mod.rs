mod logic;
mod smoke;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

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
pub struct SelectAndExportReportRequest {
    pub default_path: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectAndExportReportResponse {
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

    let script = match logic::finalize_test_start_reservation(state.inner(), &script, &run_id) {
        Ok(script) => script,
        Err(error) => {
            logic::release_failed_start(state.inner(), &run_id);
            return Err(error);
        }
    };

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
    let logic::TestStopRequest::Requested {
        run_id,
        process_error,
    } = logic::request_test_stop(state.inner())?
    else {
        return Ok(());
    };

    if let Err(wait_error) = logic::wait_for_test_stop(state.inner(), &run_id) {
        return Err(process_error.unwrap_or(wait_error));
    }

    logic::finalize_test_stop(state.inner(), &run_id)
}

#[tauri::command]
pub async fn smoke_test_requests(
    state: State<'_, SharedAppState>,
    request: SmokeTestRequest,
) -> Result<SmokeTestResponse, String> {
    let (resolved_requests, reservation) =
        logic::reserve_and_resolve_smoke_test(state.inner(), &request.options)?;

    tauri::async_runtime::spawn_blocking(move || {
        run_reserved_smoke_test(resolved_requests, reservation)
    })
    .await
    .map_err(|error| format!("Smoke test task failed unexpectedly: {error}"))?
}

fn run_reserved_smoke_test(
    resolved_requests: Vec<crate::importing::ResolvedRuntimeRequest>,
    _reservation: logic::SmokeTestReservation,
) -> Result<SmokeTestResponse, String> {
    smoke::run_smoke_test(resolved_requests)
}

#[tauri::command]
pub async fn select_and_export_report(
    app: AppHandle,
    state: State<'_, SharedAppState>,
    request: SelectAndExportReportRequest,
) -> Result<Option<SelectAndExportReportResponse>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Save Load Rift Report")
        .set_file_name(request.default_path)
        .add_filter("HTML", &["html", "htm"])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "The selected report path is not available on this platform.".to_string())?;
    let saved_path = crate::k6::export_report_file_to_path(state.inner(), &path)?;

    Ok(Some(SelectAndExportReportResponse {
        save_path: saved_path.display().to_string(),
    }))
}

#[tauri::command]
pub fn get_test_status(state: State<'_, SharedAppState>) -> Result<GetTestStatusResponse, String> {
    logic::get_test_status_response(state.inner())
}

#[cfg(test)]
mod tests;
