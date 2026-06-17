# Third-Party Licenses

Load Rift packages its own MIT-licensed application code, a bundled k6 runtime
binary, and application dependencies from the npm and Cargo ecosystems. This
file documents the separately licensed bundled runtime component and the
current top-level production dependency inventory used by the app.

## k6 Load Testing Tool

License: GNU Affero General Public License v3.0 only (AGPL-3.0-only)
Project website: https://grafana.com/oss/k6/
Upstream repository: https://github.com/grafana/k6
Bundled version: v2.0.0
Bundled release: https://github.com/grafana/k6/releases/tag/v2.0.0
Corresponding source tree: https://github.com/grafana/k6/tree/v2.0.0
Corresponding source archive: https://github.com/grafana/k6/archive/refs/tags/v2.0.0.tar.gz
Bundled release assets:
- `k6-v2.0.0-linux-amd64.tar.gz`
- `k6-v2.0.0-linux-arm64.tar.gz`
- `k6-v2.0.0-macos-amd64.zip`
- `k6-v2.0.0-macos-arm64.zip`

Load Rift bundles unmodified official k6 binaries for supported Linux and
macOS packaging targets. Those binaries are downloaded from official Grafana
k6 releases by `scripts/install-k6.sh`.

The full AGPL-3.0-only license text shipped with this repository is available in
`licenses/AGPL-3.0.txt`.

The bundled binary location and its adjacent notice are:
- `src-tauri/bin/`
- `src-tauri/bin/README.md`

## Application Dependencies

The frontend production dependencies are resolved by `package-lock.json`; the
Rust application dependencies are resolved by `src-tauri/Cargo.lock`. The direct
dependencies used by packaged application code are currently permissively
licensed:

| Ecosystem | Package | Version | License |
| --- | --- | --- | --- |
| npm | `@tauri-apps/api` | 2.11.0 | Apache-2.0 OR MIT |
| npm | `@tauri-apps/plugin-dialog` | 2.7.1 | MIT OR Apache-2.0 |
| npm | `react` | 19.2.7 | MIT |
| npm | `react-dom` | 19.2.7 | MIT |
| Cargo | `hdrhistogram` | 7.5.4 | MIT/Apache-2.0 |
| Cargo | `log` | 0.4.29 | MIT OR Apache-2.0 |
| Cargo | `reqwest` | 0.13.3 | MIT OR Apache-2.0 |
| Cargo | `serde` | 1.0.228 | MIT OR Apache-2.0 |
| Cargo | `serde_json` | 1.0.149 | MIT OR Apache-2.0 |
| Cargo | `tauri` | 2.11.2 | Apache-2.0 OR MIT |
| Cargo | `tauri-plugin-dialog` | 2.7.1 | Apache-2.0 OR MIT |
| Cargo | `tauri-plugin-log` | 2.8.0 | Apache-2.0 OR MIT |
| Cargo | `tempfile` | 3.27.0 | MIT OR Apache-2.0 |
| Cargo | `uuid` | 1.23.1 | Apache-2.0 OR MIT |
| Cargo build | `tauri-build` | 2.6.2 | Apache-2.0 OR MIT |

Before a release, regenerate or review the transitive dependency inventory from
the committed lockfiles. Useful source commands are:

```bash
node -e 'const lock=require("./package-lock.json"); const deps=lock.packages[""].dependencies; for (const name of Object.keys(deps)) { const p=lock.packages[`node_modules/${name}`]; console.log(`${name}\t${p?.version}\t${p?.license}`); }'
cargo metadata --manifest-path "src-tauri/Cargo.toml" --format-version 1
```

If a future runtime dependency introduces a copyleft, source-available,
commercial, or otherwise non-permissive license, update this notice and the
packaged bundle resources before publishing artifacts.

When publishing packaged app binaries outside this repository, include this
notice next to the download or release entry:

```text
This package bundles Grafana k6 v2.0.0, licensed under AGPL-3.0-only.
Corresponding source: https://github.com/grafana/k6/tree/v2.0.0
Source archive: https://github.com/grafana/k6/archive/refs/tags/v2.0.0.tar.gz
Additional bundled licensing notices are included in the package.
```
