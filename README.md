# Load Rift

Load Rift is a Tauri desktop app for importing Postman collections and running local k6 tests.

This repository currently contains the first working Tauri vertical slice:
- Tauri 2 backend setup
- React + TypeScript frontend setup
- A typed frontend API layer
- Postman collection import from file
- Local k6 execution with live output, metrics, status tracking, and richer HTML report export
- Advanced k6 options JSON for scenarios, thresholds, tags, and other settings that do not fit the basic controls
- Bundled project-local k6 binary for Linux and macOS desktop builds

## Prerequisites

- Node.js 22+
- npm
- Rust and Cargo
- Tauri system dependencies

On this machine, `cargo check` succeeded against the current Linux GTK/WebKit stack.

## Install

```bash
npm install
npm run install:k6
```

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
- `npm run lint`: runs ESLint
- `npm run typecheck`: runs TypeScript checks
- `npm run build`: builds the frontend into `dist/`
- `npm run install:k6`: downloads the project-local k6 binary into `src-tauri/bin/`
- `npm run tauri dev`: runs the desktop app in dev mode
- `npm run tauri build`: builds the desktop app and writes bundles to `src-tauri/target/release/bundle/`

## Current Behavior

The app currently provides a slim migration shell with:
- File import entry point
- A test harness panel for start, stop, and status
- Basic runner controls for common load-test setup
- An advanced k6 options JSON area for scenarios, tags, thresholds, and other custom options
- Clear override behavior: if you define top-level `scenarios`, `stages`, or `iterations` in the advanced JSON, those settings override the basic runner controls
- HTML report export with summary cards, threshold results, structured metrics, the raw k6 summary JSON, and the final console summary from k6
- Event listeners for:
  - `k6:output`
  - `k6:metrics`
  - `k6:complete`
  - `k6:error`

## Runtime Notes

- Supported Linux and macOS builds vendor `k6` `v1.6.1` into `src-tauri/bin/`
  using the platform-specific target triple filename.
- Tauri bundles those binaries as application resources, so packaged Linux and
  macOS artifacts do not rely on a system-wide k6 install.
- At runtime the app still honors `LOADRIFT_K6_BIN` first, which is useful for local overrides or debugging.

## Licensing

- Load Rift is licensed under MIT. See `LICENSE`.
- The root `LICENSE` file contains only the project's MIT license text so GitHub
  and package tooling can detect it cleanly.
- Packaged Linux and macOS builds bundle `k6` `v1.6.1`, which is licensed
  separately under AGPL-3.0.
- See `THIRD_PARTY_LICENSES.md` for the exact bundled `k6` version and
  corresponding source references.
- See `licenses/AGPL-3.0.txt` for the AGPL-3.0 license text shipped with this
  repository.
- Tauri bundle resources also ship these licensing documents inside the app,
  and Linux AppImage/`.deb`/`.rpm` outputs install copies under
  `/usr/share/doc/loadrift/`.

## Release Notice

When publishing packaged app binaries, include a release note alongside the
download that calls out the bundled `k6` binary and its corresponding source.
Use this template:

```text
This package bundles Grafana k6 v1.6.1, licensed under AGPL-3.0.
Corresponding source: https://github.com/grafana/k6/tree/v1.6.1
Source archive: https://github.com/grafana/k6/archive/refs/tags/v1.6.1.tar.gz
Additional bundled licensing notices are included in the package.
```

## Project Structure

- `src/`: React frontend
- `src/lib/loadrift/`: shared TS types and frontend API contract
- `src/lib/tauri/`: Tauri-specific frontend adapter
- `src/features/`: frontend hooks and flow state
- `src-tauri/`: Rust backend
