# Release Notes Template

Use `.github/RELEASE_TEMPLATE.md` when publishing packaged app binaries on
GitHub Releases.

## Suggested Release Notes for v0.2.0

```md
## Summary

- Added support for advanced k6 load profiles through the Raw k6 Options JSON area.
- Advanced top-level `scenarios`, `stages`, and `iterations` now override the basic runner controls instead of conflicting with them.
- Improved the exported HTML report with summary cards, threshold results, structured metrics, raw k6 summary JSON, and the final console summary from k6.
- Updated the app metadata to version `0.2.0`.

## Downloads

- Linux AppImage: _link_
- Linux `.deb`: _link_
- Linux `.rpm`: _link_
- macOS `.dmg`: _link_

## Bundled Third-Party Software

This package bundles Grafana k6 v1.6.1, licensed under AGPL-3.0.
Corresponding source: https://github.com/grafana/k6/tree/v1.6.1
Source archive: https://github.com/grafana/k6/archive/refs/tags/v1.6.1.tar.gz
Additional bundled licensing notices are included in the package.

## Verification

- [ ] `npm run build`
- [ ] `npm run tauri build`
- [ ] Packaged artifacts include bundled license documents
```

Required third-party notice for bundled builds:

```text
This package bundles Grafana k6 v1.6.1, licensed under AGPL-3.0.
Corresponding source: https://github.com/grafana/k6/tree/v1.6.1
Source archive: https://github.com/grafana/k6/archive/refs/tags/v1.6.1.tar.gz
Additional bundled licensing notices are included in the package.
```

Keep the `k6` version and source links in sync with `scripts/install-k6.sh` and
`THIRD_PARTY_LICENSES.md` whenever the bundled version changes.
