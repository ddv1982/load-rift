# Load Rift

Load Rift is a Tauri desktop app for importing Postman collections and running local k6 tests.

This repository currently contains the first working Tauri vertical slice:
- Tauri 2 backend setup
- React + TypeScript frontend setup
- A typed frontend API layer
- Postman collection import from file and URL
- Local k6 execution with live output, metrics/status tracking, and report export
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
- File / URL import entry points
- A test harness panel for start / stop / status
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
- URL import uses Tauri's HTTP client instead of host `curl`/`wget` binaries.

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

## Project Structure

- `src/`: React frontend
- `src/lib/loadrift/`: shared TS types and frontend API contract
- `src/lib/tauri/`: Tauri-specific frontend adapter
- `src/features/`: frontend hooks and flow state
- `src-tauri/`: Rust backend
