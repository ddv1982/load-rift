# Release Notes Template

Use `.github/RELEASE_TEMPLATE.md` when publishing packaged app binaries on
GitHub Releases.

The GitHub Actions release workflow reads `docs/releases/<tag>.md` when it
exists, and falls back to `.github/RELEASE_TEMPLATE.md` otherwise. For a tagged
release like `v0.2.2`, prefer adding `docs/releases/v0.2.2.md` before pushing
the tag so the CI-built Linux packages publish with the correct notes and
bundled third-party notice.

## Suggested Release Notes for v0.2.2

```md
## Summary

- Rebuilt Linux release packaging on Ubuntu 22.04 to improve `.deb` compatibility on target systems.
- Kept the Linux release pipeline aligned with the verified CI runner image.
- Updated the app metadata to version `0.2.2`.

## Downloads

- Linux AppImage: _link_
- Linux `.deb`: _link_
- Linux `.rpm`: _link_

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
