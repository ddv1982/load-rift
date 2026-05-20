This directory contains bundled third-party runtime binaries used by Load Rift.

Bundled component:
- `k6-x86_64-unknown-linux-gnu`
- `k6-aarch64-unknown-linux-gnu` when installed on Linux ARM64
- `k6-x86_64-apple-darwin` when installed on macOS Intel
- `k6-aarch64-apple-darwin` when installed on macOS Apple Silicon

Current bundled upstream version:
- `k6` `v2.0.0`

`scripts/install-k6.sh` includes checksums for this default version. If you run it with a custom `K6_VERSION`, set `K6_SHA256` to the expected checksum for the matching platform archive; custom versions without an explicit checksum are rejected before download.

License:
- GNU Affero General Public License v3.0 only (`AGPL-3.0-only`)
- Full AGPL-3.0-only license text: `../../licenses/AGPL-3.0.txt`

Corresponding source for the exact bundled version:
- Release page: https://github.com/grafana/k6/releases/tag/v2.0.0
- Source tree: https://github.com/grafana/k6/tree/v2.0.0
- Source archive: https://github.com/grafana/k6/archive/refs/tags/v2.0.0.tar.gz

The binaries in this directory are downloaded by `scripts/install-k6.sh` from
official Grafana k6 releases and are used as sidecar executables by the Tauri
application.
