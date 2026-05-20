# Investigation: k6 temporary script missing during load test

## Summary
k6 was found and launched; the observed failure is that the launched k6 process could not read Load Rift's generated entry script at `/tmp/loadrift-Xmo41w/script.js`. The missing `summary.json` is a downstream consequence of that early script-load failure, not evidence that bundled k6 was absent.

## Symptoms
- k6 emitted: `The moduleSpecifier "/tmp/loadrift-Xmo41w/script.js" couldn't be found on local disk.`
- Load Rift reported: `Load Rift used live metrics because the structured k6 summary could not be processed`.
- The summary file path was `/tmp/loadrift-Xmo41w/summary.json`, and the OS reported it did not exist.
- User expectation: k6 should be packaged in the app, so running a load test should not require a separately installed k6 binary.

## Background / Prior Research
- Ref/Grafana k6 docs: local modules/scripts are filesystem-backed; k6 local module resolution requires the referenced local path to exist and be accessible. k6 uses browser-like module resolution, not Node.js package resolution. Source: `grafana/k6-docs`, modules docs.
- Exa/GitHub issue evidence: Grafana maintainers have explained this exact error class as meaning the file is not where the k6 process can access it, even when the wording includes Docker guidance.
- Ref/Grafana k6 v2 release-note evidence: v2.0 removed `--no-summary`, migrating users to `--summary-mode=disabled`; no external evidence found so far that v2 changed successful `--summary-export` semantics for a missing entry script.
- Explore agent external source review: k6 loader source reports `couldn't be found on local disk` when filesystem read returns `fs.ErrNotExist`; k6 `run` loads the configured test before summary setup, so if the entry script cannot be loaded, `--summary-export` should not create `summary.json`. Sources: `grafana/k6 internal/loader/loader.go`, `internal/cmd/run.go`, and Grafana k6 option docs for `--summary-export`.

## Investigator Findings

### 2026-05-20 read-only trace

#### Ranked synthesis

| Rank | Explanation | Confidence | Basis |
|---|---:|---:|---|
| 1 | k6 did start, then failed while opening the generated entry script path; the missing `summary.json` is a downstream consequence of that early k6 load failure. | High | `start_k6_process` resolves a k6 binary, creates `script.js`, then invokes `k6 run --summary-export <summary.json> --out json=<metrics.json> <script.js>` (`src-tauri/src/k6/process/runtime.rs:36-72`). k6 stderr says the entry script path could not be found; the waiter falls back only after `fs::read_to_string(summary_path)` fails (`src-tauri/src/k6/process/runtime.rs:303-333`). |
| 2 | A bundled-k6 packaging/missing-binary issue is not the primary failure class for the observed log. | High | If no packaged/path k6 is found, `resolve_k6_binary` returns a Load Rift startup error before spawn (`src-tauri/src/k6/process/runtime.rs:517-606`). The observed error is emitted by a launched k6 process trying to load `/tmp/loadrift-Xmo41w/script.js`. Packaging config does bundle `bin/` resources (`src-tauri/tauri.conf.json:45-51`) and release CI installs k6 before tests/build (`.github/workflows/release.yml:64-76`, `.github/workflows/release.yml:155-157`). |
| 3 | Normal Load Rift ownership does not drop the temp directory before/during the k6 child lifetime; an external namespace/accessibility/lifetime problem remains possible but is not proven by repository code. | Medium | `RunTempArtifacts` owns a `tempfile::TempDir` (`src-tauri/src/k6/process/runtime.rs:18-23`), is moved into the waiter thread after successful spawn (`src-tauri/src/k6/process/runtime.rs:164-177`), and the waiter keeps it while polling `child.try_wait()` until exit, joining forwarders, then reading `summary.json` (`src-tauri/src/k6/process/runtime.rs:254-333`). Tests confirm drop removes the directory (`src-tauri/src/k6/tests.rs:461-483`). |

#### End-to-end flow evidence

- Generated script storage starts in import: `import_collection` calls `script::generate_k6_script` and returns `ImportedCollection { script, runtime_collection }` (`src-tauri/src/importing/mod.rs:70-107`). `import_collection_into_state` stores `imported.script` in `app_state.generated_script` and clears previous run state (`src-tauri/src/commands/collection/service.rs:23-35`).
- `start_test` reserves a run id, clones the generated script from app state, validates options, finalizes the reservation, then passes the script string into `crate::k6::start_k6_process` (`src-tauri/src/commands/testing/mod.rs:42-76`; `src-tauri/src/commands/testing/logic.rs:58-104`). No filesystem path exists until `start_k6_process` creates it.
- `start_k6_process` resolves k6 first, then creates temp artifacts, clones `script_path`, `summary_path`, and `metrics_path`, and builds the command with `--summary-export`, `--out json=...`, and the script path as the final positional argument (`src-tauri/src/k6/process/runtime.rs:36-72`).
- Temp artifact creation uses a `loadrift-*` temp directory, restricts the directory to `0700` on Unix, writes `script.js`, and stores `summary.json`/`metrics.json` paths in the same directory (`src-tauri/src/k6/process/runtime.rs:478-500`). The script file is created with `create_new` and mode `0600` on Unix (`src-tauri/src/k6/process/runtime.rs:503-516`).
- After `command.spawn()` succeeds, Load Rift stores running state and starts stdout/stderr, metrics, and waiter threads (`src-tauri/src/k6/process/runtime.rs:128-177`). The stdout/stderr forwarders append each line to `latest_output` and emit `k6:output` (`src-tauri/src/k6/process/runtime.rs:200-230`).
- The waiter owns `RunTempArtifacts`, waits for child exit via `try_wait`, then shuts down metrics, joins output forwarders, and only then reads `summary.json` (`src-tauri/src/k6/process/runtime.rs:254-333`). This disproves normal in-process early temp cleanup as the cause.
- If `summary.json` is missing or unreadable, Load Rift calls `emit_live_metrics_fallback_completion`, derives a result from live metrics, emits normal completion, then appends the fallback line: `Load Rift used live metrics because...` (`src-tauri/src/k6/process/runtime.rs:407-432`).

#### UI and reporting evidence

- Backend completion storage clears `latest_error_message` even for failed completion/fallback paths because `store_completion` writes `latest_result`, `latest_summary_json`, `latest_finish_reason`, then sets `latest_error_message = None` (`src-tauri/src/k6/process/state.rs:70-89`). `get_test_status` exposes only that cleared error field (`src-tauri/src/commands/testing/logic.rs:39-53`).
- For a non-threshold non-zero exit, `emit_completion` emits a generic `k6:error`: `k6 exited with a non-zero status for a reason other than threshold failures.` (`src-tauri/src/k6/process/runtime.rs:372-398`). It does not promote the captured stderr line (`script.js couldn't be found`) into the structured error.
- Frontend `useTestHarness` appends all `k6:output` lines to `state.output`, handles `k6:complete` by setting result/finish reason and clearing `error`, then accepts a following `k6:error` for failed completions and sets `error` to the generic event message (`src/features/test/useTestHarness.ts:66-151`).
- `LiveRunMonitorCard` displays raw output plus inline error (`src/app/components/LiveRunMonitorCard.tsx:20-57`), while `LatestResultCard` receives only `result` and displays metrics/status without finish reason or underlying stderr (`src/app/components/LatestResultCard.tsx:4-75`; `src/app/components/TestHarnessSection.tsx:371-397`). This partially hides the primary script-missing cause: it remains in the monitor log/report output, but the structured UI error path favors fallback/generic status.
- Report export reads `latest_result`, `latest_output`, and `latest_summary_json` only (`src-tauri/src/k6/report.rs:189-207`), so the console output can preserve stderr but no structured primary error is persisted.

#### Test coverage findings

- Existing private temp tests verify creation, readability by the Rust process, colocated summary/metrics paths, Unix permission restriction, and cleanup on drop; they do not spawn k6 (`src-tauri/src/k6/tests.rs:461-512`).
- Existing real bundled-k6 tests run `Command::new(k6).arg("run")` and verify summary export/parsing, but they use `process::write_temp_file`, which writes directly under `env::temp_dir()` with `fs::write`, not `create_run_temp_artifacts`' private `TempDir`/`0700`/`0600` path (`src-tauri/src/k6/tests.rs:714-797`; `src-tauri/src/k6/process/runtime.rs:646-656`).
- Import/generated-script integration tests likewise run bundled k6 with `temp_artifact_path`/`fs::write`, not the production private artifact helper (`src-tauri/src/importing/tests.rs:902-945`).
- Coverage gap: no test combines the real bundled k6 binary with `create_run_temp_artifacts(...)` and `k6 run --summary-export <private summary> <private script>`.

#### Eliminated and remaining hypotheses

- Eliminated: `summary.json` absence as an independent root cause. In this flow it is expected after k6 cannot load the entry script, because Load Rift only reads the summary after k6 exits and falls back when the file is absent (`src-tauri/src/k6/process/runtime.rs:303-333`).
- Eliminated for the normal path: Load Rift dropping `RunTempArtifacts` before/during a successfully spawned child. Ownership is moved into the waiter and retained until after child exit (`src-tauri/src/k6/process/runtime.rs:164-177`, `src-tauri/src/k6/process/runtime.rs:254-333`).
- Down-ranked: missing bundled binary or basic packaging failure. A missing binary would fail `start_k6_process` before k6 emits loader stderr (`src-tauri/src/k6/process/runtime.rs:517-606`).
- Remaining: k6 could be unable to see the temp path due to environment/namespace/accessibility outside the normal Rust ownership model, or an abnormal waiter early return could drop the temp dir if child access fails in a nonstandard way. Repository evidence does not prove either; the direct discriminating test is missing.

#### Recommended fix locations

- Add a Rust integration test in `src-tauri/src/k6/tests.rs` that uses `create_run_temp_artifacts` with real/bundled k6, verifies `script_path.is_file()` immediately before spawn, runs `k6 run --summary-export <summary_path> <script_path>`, and asserts summary creation. This directly covers the production private-temp contract.
- In `src-tauri/src/k6/process/runtime.rs`, add targeted diagnostics around `create_run_temp_artifacts`/spawn/fallback: log the resolved k6 path, script path existence/metadata before spawn, and script path existence/metadata when summary fallback happens. That would separate external deletion/namespace/accessibility from k6/summary behavior.
- In `src-tauri/src/k6/process/runtime.rs` and `src-tauri/src/k6/process/state.rs`, preserve the primary stderr/error tail for failed fallback completions instead of clearing `latest_error_message` and emitting only the generic non-zero error.
- In `src/features/test/useTestHarness.ts`, `src/app/components/LiveRunMonitorCard.tsx`, and `src/app/components/LatestResultCard.tsx`, surface `finishReason` and primary failure text alongside fallback metrics so the final UI does not make the summary fallback look like the root cause.

## Investigation Log

### Phase 1 - Initial assessment
**Hypothesis:** The failure may be about the temporary generated k6 script path, not about whether the k6 binary is bundled.
**Findings:** Investigation started. Need to trace how Load Rift creates the temp working directory, writes `script.js`, invokes bundled k6, and cleans up after the process.
**Evidence:** User-provided runtime error.
**Conclusion:** Needs investigation.

## Root Cause

### Evidence-backed root-cause class
Load Rift successfully reached k6 execution, but k6 could not read the generated entry script at `/tmp/loadrift-Xmo41w/script.js` during module loading.

Evidence:
- `start_k6_process` resolves a k6 binary, creates temp artifacts, and launches `k6 run --summary-export <summary_path> --out json=<metrics_path> <script_path>` (`src-tauri/src/k6/process/runtime.rs:36-72`).
- The reported error is emitted by k6 itself, so a k6 executable existed and ran far enough to try loading the entry script.
- `RunTempArtifacts` owns the private `TempDir` (`src-tauri/src/k6/process/runtime.rs:18-23`) and is moved into the waiter thread after spawn (`src-tauri/src/k6/process/runtime.rs:164-177`). The waiter keeps it while waiting for child exit and only then reads `summary.json` (`src-tauri/src/k6/process/runtime.rs:254-333`).
- The temp helper creates `/tmp/loadrift-*`, writes `script.js`, and uses private Unix permissions: directory `0700`, script `0600` (`src-tauri/src/k6/process/runtime.rs:478-516`).
- External k6 source review found that missing entry-script load happens before summary setup, so no `summary.json` should be expected when k6 cannot load the entry script.

### What is eliminated
- Missing bundled k6 as the primary failure: missing-binary lookup would fail before `spawn()`, while the observed error is k6 stderr.
- Invalid generated JavaScript as the direct cause: syntax/import/runtime errors would not normally say the entry file itself could not be found.
- Missing `summary.json` as an independent root cause: it is expected after k6 fails before summary setup.
- Normal in-process early temp cleanup: repository code keeps `RunTempArtifacts` alive in the waiter thread until after child exit.

### What remains unproven
The repository does not prove why the file was unavailable to k6. Remaining plausible mechanisms are:
- packaged-runtime sandbox or `/tmp` namespace mismatch;
- k6 process running with a different UID/context than the app;
- private `0700` directory / `0600` script permissions interacting badly with the packaged runtime;
- external deletion/cleanup of `/tmp/loadrift-*`;
- unexpected binary selection through `LOADRIFT_K6_BIN` or PATH fallback, not a missing binary but a different execution context.

## Recommendations
1. Add a production-temp bundled-k6 integration test in `src-tauri/src/k6/tests.rs`: use `create_run_temp_artifacts`, assert `script_path.is_file()` before spawn, run bundled k6 with `--summary-export artifacts.summary_path artifacts.script_path`, assert summary creation before drop, then assert cleanup after drop.
2. Add a negative reproduction test: drop `RunTempArtifacts` before invoking k6 with the saved `script_path`, and assert the same missing-module/file-not-found class plus absent summary. That would prove this user-visible error is consistent with temp disappearance/inaccessibility.
3. Add targeted diagnostics in `src-tauri/src/k6/process/runtime.rs` around launch and fallback: resolved k6 path, binary source (`env`, resource, executable dir, manifest bin, PATH), temp paths, `script_path.exists()/is_file()` before spawn, Unix mode metadata, child exit code, and whether `script_path` still exists when summary fallback occurs. Do not log script contents.
4. Preserve the primary k6 stderr/error tail for failed completions. Current flow stores raw output but structured failure handling favors a generic non-threshold error and summary fallback (`src-tauri/src/k6/process/state.rs:70-89`, `src-tauri/src/k6/process/runtime.rs:372-432`, `src/features/test/useTestHarness.ts:100-151`).
5. Improve UI/reporting so summary fallback is clearly secondary. Show `finishReason` and the primary k6 failure text alongside fallback metrics in the live monitor/latest result surfaces.
6. Run a packaged smoke probe after diagnostics land using the actual artifact type that produced the failure (AppImage/deb/rpm/dmg). This is the probe most likely to expose `/tmp` namespace or packaged runtime behavior.

## Follow-up Implemented
- Added backend result-source and summary-issue state so live-metrics fallback is identified as fallback context rather than the root cause.
- Preserved bounded primary k6 stderr/error text through failed fallback completions and frontend display.
- Added k6 binary/source and temp artifact diagnostics without logging generated script contents.
- Added regression coverage for production private temp artifacts, including dropped-temp missing-script reproduction and macOS/Linux bundled-k6 test helper names.
- Updated frontend state and result surfaces to show finish reason, primary k6 error, result source, and fallback context.

## Preventive Measures
- Keep a regression test that exercises real k6 against the same private temp artifact contract used in production, not only direct temp files created by test helpers.
- Treat summary fallback as a diagnostic fallback, not the causal error, in both stored state and UI copy.
- Record binary source and temp artifact metadata for failed k6 launches so future reports can distinguish packaging, PATH fallback, script generation, and sandbox/access problems.
