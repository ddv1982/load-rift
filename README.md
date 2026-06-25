# Load Rift

Load Rift is a Tauri desktop app for importing Postman collections and running local k6 tests.

This repository currently contains the first working Tauri vertical slice:
- Tauri 2 backend setup
- React + TypeScript frontend setup
- A typed frontend API layer
- Postman collection import from file
- Local k6 execution with live output, metrics, status tracking, and richer HTML report export
- Advanced k6 options JSON for scenarios, thresholds, tags, and other settings that do not fit the basic controls
- Optional weighted request mix mode for request-level traffic importance
- Bundled project-local k6 binary for Linux and macOS desktop builds

## Prerequisites

- Node.js 22+
- npm
- Rust and Cargo
- Tauri system dependencies

On this machine, `cargo check` succeeded against the current Linux GTK/WebKit stack.

## Install

Desktop builds are published on the GitHub Releases page:

- [Releases](https://github.com/ddv1982/load-rift/releases)

### macOS

Download the `.dmg` for your Mac from the latest release:

- Apple Silicon: `aarch64` / ARM64
- Intel: `x64`

Open the `.dmg` and drag Load Rift into Applications.

### Linux

Linux builds require a distro with **WebKitGTK 4.1**.

Enable the repository once per machine:

```bash
bash <(curl -fsSL https://github.com/ddv1982/load-rift/releases/latest/download/install-apt-repo.sh)
```

The setup script verifies a detached GPG signature and package checksum before installing the Load Rift archive keyring and APT source configuration. If signature authentication is unavailable, the script fails before installing.

Refresh APT metadata:

```bash
sudo apt update
```

Install Load Rift:

```bash
sudo apt install load-rift
```

After the repository is enabled, use normal `sudo apt update` and `sudo apt install load-rift` commands for installs and updates.

The standalone `.AppImage`, `.deb`, and `.rpm` release assets remain available as direct-download fallback options.

## Local Development Setup

```bash
npm install
npm run install:k6
```

`npm run install:k6` uses built-in checksums for the default bundled k6 version. If you override `K6_VERSION`, also set `K6_SHA256` to the expected checksum for the selected platform archive.

## Run In Development

```bash
npm run tauri dev
```

This starts the Vite frontend and the Tauri desktop shell together.

## Build

```bash
npm run build
```

This builds the frontend only and writes the static assets to `dist/`.

To build the Tauri app bundle:

```bash
npm run tauri build
```

Build outputs land in:
- `dist/`: frontend build output used by Tauri
- `src-tauri/target/release/`: compiled Rust release binaries
- `src-tauri/target/release/bundle/`: packaged desktop artifacts

Common bundle subdirectories under `src-tauri/target/release/bundle/` include:
- Linux: `appimage/`, `deb/`, `rpm/`
- macOS: `macos/`, `dmg/`

Tauri produces native bundles for the current build platform, so Linux bundles
must be built on Linux and macOS bundles must be built on macOS.

## Clean Rebuild

You usually do **not** need to run a clean step before building.

Use a clean rebuild only when troubleshooting stale Rust/Tauri artifacts,
native-toolchain changes, or unusual linker/compiler errors:

```bash
rm -rf dist
cargo clean --manifest-path src-tauri/Cargo.toml
npm run build
# or
npm run tauri build
```

`cargo clean` removes Rust build artifacts and makes the next build slower, so
it should be treated as a troubleshooting step rather than a normal part of the
build workflow.

## Useful Scripts

- `npm run dev`: starts the Vite frontend only
- `npm run format`: formats frontend source, root config, and CI workflow files with Prettier
- `npm run lint`: runs ESLint
- `npm run typecheck`: runs TypeScript checks
- `npm run test:coverage`: runs Vitest with V8 coverage, including uncovered files under `src/`
- `npm run test:browser-smoke`: runs the browser import/configure/smoke/load/export workflow smoke with Playwright Chromium
- `npm run test:workflow-smoke`: runs the focused jsdom workflow tests, browser workflow smoke, and large importer regression
- `npm run benchmark:large-collection`: runs Vitest large-collection model benchmarks and the Rust large-import fixture with timing output
- `npm run rust:fmt`: checks Rust formatting with `cargo fmt --check`
- `npm run rust:clippy`: runs Clippy for all targets and features with warnings denied
- `npm run rust:audit`: audits Cargo dependencies with `cargo-audit`
- `npm run verify`: runs typecheck, lint, frontend tests, frontend build, Rust fmt, Clippy, audit, tests, and check
- `npm run build`: builds the frontend into `dist/`
- `npm run install:k6`: downloads the project-local k6 binary into `src-tauri/bin/`
- `npm run tauri dev`: runs the desktop app in dev mode
- `npm run tauri build`: builds the desktop app and writes bundles to `src-tauri/target/release/bundle/`

## Validation

Use the narrowest command that covers the change while developing:
- Frontend state/UI changes: `npm test`, plus `npm run typecheck` when types or contracts changed
- Frontend coverage review: `npm run test:coverage`
- Import/configure/smoke/load/export workflow evidence: `npm run test:workflow-smoke`
- Large collection import/render performance evidence: `npm run benchmark:large-collection`
- Rust backend, import, k6, or report changes: `cargo test --manifest-path src-tauri/Cargo.toml`, plus `npm run rust:clippy` for shared process or command changes
- Packaging/config/docs that affect release shape: `npm run build`, `cargo check --manifest-path src-tauri/Cargo.toml`, and workflow/static review

Install the Rust audit tool before running the dependency audit locally:

```bash
cargo install cargo-audit --version 0.22.2 --locked
npm run rust:audit
```

Before publishing or handing off a broad change, run:

```bash
npm run verify
```

`npm run verify` intentionally mirrors the local broad gate and includes the
frontend build plus Rust format, Clippy, audit, test, and check commands. Install
the bundled k6 binary first with `npm run install:k6` when you need local parity
with CI's mandatory bundled k6 regression tests.

Coverage reports are available through `npm run test:coverage`. Focused workflow
smoke evidence is available through `npm run test:workflow-smoke`. The browser
smoke uses a gated `VITE_LOADRIFT_E2E=true` API fixture to cover the real React
workflow without native dialogs and writes screenshots to `docs/quality/screenshots/`.
Full Tauri-driver desktop checks are still manual because they require
platform-native WebDriver setup (`tauri-driver` plus `WebKitWebDriver` on Linux).
Capture desktop import-to-export smoke evidence when releases change native dialog
or filesystem behavior.

## Current Behavior

The app currently provides a slim migration shell with:
- File import entry point
- A test harness panel for start, stop, and status
- Basic runner controls for common load-test setup, including sequential vs weighted request mix
- An advanced k6 options JSON area for scenarios, tags, thresholds, and other custom options
- Weighted request mixes follow a deterministic request schedule across started iterations, and weight `0` excludes a request from the weighted pool; use advanced k6 scenarios/executors for stricter fixed workload ratios
- Clear override behavior: if you define top-level `scenarios`, `stages`, or `iterations` in the advanced JSON, those settings override the basic runner controls
- HTML report export with summary cards, threshold results, structured metrics, the raw k6 summary JSON, and the final console summary from k6
- Event listeners for:
  - `k6:output`
  - `k6:metrics`
  - `k6:complete`
  - `k6:error`

## Runtime Notes

- Supported Linux and macOS builds vendor `k6` `v2.0.0` into `src-tauri/bin/`
  using the platform-specific target triple filename.
- Custom `K6_VERSION` installs require `K6_SHA256` for the matching k6 release archive; built-in checksums only apply to the default bundled version.
- Tauri bundles those binaries as application resources, so packaged Linux and
  macOS artifacts do not rely on a system-wide k6 install.
- At runtime the app still honors `LOADRIFT_K6_BIN` first, which is useful for local overrides or debugging.
- Load Rift writes each run's generated `script.js`, `summary.json`, and `metrics.json` paths into a private per-run temp directory. Startup cleanup only removes old Load Rift-owned k6 artifact directories when the marker schema, k6-child PID role, expected file shape, staleness, and conservative PID-liveness checks all prove deletion is safe; markerless, malformed, preserved, active, symlinked, or unknown-shape directories are skipped.
- User-visible fallback diagnostics redact local artifact paths by default. Full artifact paths are kept for logs and for explicit debug preservation mode.
- Set `LOADRIFT_PRESERVE_K6_ARTIFACTS=true` only when debugging k6 temp-file issues. This preserves the per-run temp directory instead of deleting it automatically and allows user-visible diagnostics to include local artifact paths; preserved artifacts can contain request URLs, headers, bodies, and tokens, so delete the directory manually when finished.
- CI requires bundled-k6 regression coverage with `LOADRIFT_REQUIRE_BUNDLED_K6_TESTS=true`. Local test runs still skip bundled-k6 tests when the platform binary is absent unless that variable is set; run `npm run install:k6` first when you want the mandatory behavior locally.
- Tauri capabilities are explicitly limited to `src-tauri/capabilities/default.json`.
  The main window only receives default core access and open/save dialog
  permissions; custom Rust commands still validate imported collections,
  runner options, filesystem paths, and k6 process state on the backend side of
  the IPC boundary.

## Licensing

- Load Rift is licensed under MIT. See `LICENSE`.
- The root `LICENSE` file contains only the project's MIT license text so GitHub
  and package tooling can detect it cleanly.
- Packaged Linux and macOS builds bundle `k6` `v2.0.0`, which is licensed
  separately under AGPL-3.0-only.
- See `THIRD_PARTY_LICENSES.md` for the exact bundled `k6` version and
  corresponding source references, plus the current top-level npm and Cargo
  application dependency license inventory.
- See `licenses/AGPL-3.0.txt` for the AGPL-3.0-only license text shipped with this
  repository.
- Tauri bundle resources also ship these licensing documents inside the app,
  and Linux AppImage/`.deb`/`.rpm` outputs install copies under
  `/usr/share/doc/loadrift/`.

## Release Notice

When publishing packaged app binaries, include a release note alongside the
download that calls out the bundled `k6` binary and its corresponding source.
Use this template:

```text
This package bundles Grafana k6 v2.0.0, licensed under AGPL-3.0-only.
Corresponding source: https://github.com/grafana/k6/tree/v2.0.0
Source archive: https://github.com/grafana/k6/archive/refs/tags/v2.0.0.tar.gz
Additional bundled licensing notices are included in the package.
```

## Project Structure

- `src/`: React frontend
- `src/lib/loadrift/`: shared TS types and frontend API contract
- `src/lib/tauri/`: Tauri-specific frontend adapter
- `src/features/`: frontend hooks and flow state
- `src-tauri/`: Rust backend
