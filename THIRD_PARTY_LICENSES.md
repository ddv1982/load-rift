# Third-Party Licenses

Load Rift bundles the following third-party runtime component in packaged
Linux and macOS builds. This file documents that shipped component, its
license, and where to obtain the corresponding source for the exact bundled
version.

## k6 Load Testing Tool

License: GNU Affero General Public License v3.0 (AGPL-3.0)
Project website: https://grafana.com/oss/k6/
Upstream repository: https://github.com/grafana/k6
Bundled version: v1.6.1
Bundled release: https://github.com/grafana/k6/releases/tag/v1.6.1
Corresponding source tree: https://github.com/grafana/k6/tree/v1.6.1
Corresponding source archive: https://github.com/grafana/k6/archive/refs/tags/v1.6.1.tar.gz
Bundled release assets:
- `k6-v1.6.1-linux-amd64.tar.gz`
- `k6-v1.6.1-linux-arm64.tar.gz`
- `k6-v1.6.1-macos-amd64.zip`
- `k6-v1.6.1-macos-arm64.zip`

Load Rift bundles unmodified official k6 binaries for supported Linux and
macOS packaging targets. Those binaries are downloaded from official Grafana
k6 releases by `scripts/install-k6.sh`.

The full AGPL-3.0 license text shipped with this repository is available in
`licenses/AGPL-3.0.txt`.

The bundled binary location and its adjacent notice are:
- `src-tauri/bin/`
- `src-tauri/bin/README.md`
