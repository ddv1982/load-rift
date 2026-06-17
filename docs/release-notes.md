# Release Notes Template

Use `.github/RELEASE_TEMPLATE.md` when publishing packaged app binaries on
GitHub Releases.

The GitHub Actions release workflow reads `docs/releases/<tag>.md` when it
exists, and falls back to `.github/RELEASE_TEMPLATE.md` otherwise. For a tagged
release like `v0.2.2`, prefer adding `docs/releases/v0.2.2.md` before pushing
the tag so the CI-built Linux packages publish with the correct notes and
bundled third-party notice.

## Suggested Release Notes Shape

```md
## Summary

- Summarize the user-visible change or packaging update.
- Mention any release pipeline, signing, or installer changes that affect users.
- Confirm the app metadata and release tag are aligned.

## Downloads

- Linux AppImage: _link_
- Linux `.deb`: _link_
- Linux `.rpm`: _link_

## Bundled Third-Party Software

This package bundles Grafana k6 v2.0.0, licensed under AGPL-3.0-only.
Corresponding source: https://github.com/grafana/k6/tree/v2.0.0
Source archive: https://github.com/grafana/k6/archive/refs/tags/v2.0.0.tar.gz
Additional bundled licensing notices are included in the package.

## Verification

- [ ] `npm run verify`
- [ ] `npm run tauri build`
- [ ] Packaged artifacts include bundled license documents
- [ ] `THIRD_PARTY_LICENSES.md` matches the current k6 version and app dependency inventory
- [ ] Browser/Tauri smoke evidence captured when the release changes user-visible workflows
```

Required third-party notice for bundled builds:

```text
This package bundles Grafana k6 v2.0.0, licensed under AGPL-3.0-only.
Corresponding source: https://github.com/grafana/k6/tree/v2.0.0
Source archive: https://github.com/grafana/k6/archive/refs/tags/v2.0.0.tar.gz
Additional bundled licensing notices are included in the package.
```

Keep the `k6` version, source links, and app dependency inventory in sync with
`scripts/install-k6.sh`, `package-lock.json`, `src-tauri/Cargo.lock`, and
`THIRD_PARTY_LICENSES.md` whenever bundled software changes.
