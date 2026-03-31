This directory contains bundled third-party runtime binaries used by Load Rift.

Bundled component:
- `k6-x86_64-unknown-linux-gnu`
- `k6-aarch64-unknown-linux-gnu` when installed on Linux ARM64
- `k6-x86_64-apple-darwin` when installed on macOS Intel
- `k6-aarch64-apple-darwin` when installed on macOS Apple Silicon

Current bundled upstream version:
- `k6` `v1.6.1`

License:
- GNU Affero General Public License v3.0 (`AGPL-3.0`)
- Full license text: `../../licenses/AGPL-3.0.txt`

Corresponding source for the exact bundled version:
- Release page: https://github.com/grafana/k6/releases/tag/v1.6.1
- Source tree: https://github.com/grafana/k6/tree/v1.6.1
- Source archive: https://github.com/grafana/k6/archive/refs/tags/v1.6.1.tar.gz

The binaries in this directory are downloaded by `scripts/install-k6.sh` from
official Grafana k6 releases and are used as sidecar executables by the Tauri
application.
