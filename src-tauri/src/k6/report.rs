use std::env;
use std::fs;
use std::path::PathBuf;

use crate::models::TestResult;
use crate::state::SharedAppState;

pub fn export_report_file(state: &SharedAppState, save_path: &str) -> Result<PathBuf, String> {
    let (result, output) = {
        let app_state = state
            .lock()
            .map_err(|_| "Failed to read the shared Tauri app state.".to_string())?;
        (
            app_state.latest_result.clone(),
            app_state.latest_output.clone(),
        )
    };

    let Some(result) = result else {
        return Err("Run a k6 test before exporting a report.".to_string());
    };

    let target_path = normalize_export_path(save_path)?;
    let report = render_report(&result, &output);
    fs::write(&target_path, report).map_err(|error| {
        format!(
            "Failed to write the report to {}: {error}",
            target_path.display()
        )
    })?;

    Ok(target_path)
}

fn normalize_export_path(save_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(save_path);
    let path = if path.is_absolute() {
        path
    } else {
        env::current_dir()
            .map_err(|error| format!("Failed to resolve the export location: {error}"))?
            .join(path)
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create the export directory {}: {error}",
                parent.display()
            )
        })?;
    }

    Ok(path)
}

pub(crate) fn extract_end_of_test_summary(output: &str) -> &str {
    for marker in [
        "\n  █ THRESHOLDS",
        "\n█ THRESHOLDS",
        "\n  █ TOTAL RESULTS",
        "\n█ TOTAL RESULTS",
    ] {
        if let Some(index) = output.find(marker) {
            return output[index + 1..].trim();
        }
    }

    output.trim()
}

pub(crate) fn render_report(result: &TestResult, output: &str) -> String {
    let summary_output = extract_end_of_test_summary(output);
    format!(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>k6 End-of-Test Summary</title>
    <style>
      :root {{
        color-scheme: dark;
        background: #0f1115;
        color: #e6e9ef;
      }}
      body {{
        margin: 0;
        padding: 24px;
        background: #0f1115;
        font-family: "IBM Plex Sans", sans-serif;
      }}
      main {{
        max-width: 1200px;
        margin: 0 auto;
      }}
      header {{
        margin-bottom: 16px;
      }}
      h1 {{
        margin: 0 0 6px;
        font-size: 22px;
      }}
      p {{
        margin: 0;
        color: #9aa3b2;
      }}
      .status {{
        color: #f4efe6;
        font-weight: 700;
      }}
      pre {{
        margin: 0;
        overflow: auto;
        padding: 24px;
        border-radius: 14px;
        border: 1px solid #262c36;
        background: #151922;
        color: #d9dee7;
        font: 14px/1.45 "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        white-space: pre-wrap;
      }}
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>k6 End-of-Test Summary</h1>
        <p>Exported from Load Rift. Final status: <span class="status">{status:?}</span></p>
      </header>
      <pre>{summary_output}</pre>
    </main>
  </body>
</html>
"#,
        status = result.status,
        summary_output = escape_html(summary_output),
    )
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
