mod commands;
mod events;
mod importing;
mod k6;
mod models;
mod state;
#[cfg(test)]
mod test_support;

use std::sync::{Arc, Mutex};

use commands::collection::import_collection_from_file;
use commands::testing::{
    export_report, get_test_status, smoke_test_requests, start_test, stop_test,
    validate_test_configuration,
};
use state::{AppState, SharedAppState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage::<SharedAppState>(Arc::new(Mutex::new(AppState::default())))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            log::info!("Load Rift Tauri foundation booted");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            import_collection_from_file,
            start_test,
            stop_test,
            smoke_test_requests,
            export_report,
            get_test_status,
            validate_test_configuration
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
