# Release Notes Template

Use `.github/RELEASE_TEMPLATE.md` when publishing packaged app binaries on
GitHub Releases.

Required third-party notice for bundled builds:

```text
This package bundles Grafana k6 v1.6.1, licensed under AGPL-3.0.
Corresponding source: https://github.com/grafana/k6/tree/v1.6.1
Source archive: https://github.com/grafana/k6/archive/refs/tags/v1.6.1.tar.gz
Additional bundled licensing notices are included in the package.
```

Keep the `k6` version and source links in sync with `scripts/install-k6.sh` and
`THIRD_PARTY_LICENSES.md` whenever the bundled version changes.
