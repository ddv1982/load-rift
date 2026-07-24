#!/usr/bin/env python3
"""Validate release asset shape and emit deterministic inventory/checksums."""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import re


REQUIRED_FILES = frozenset(
    {
        "LICENSE",
        "THIRD_PARTY_LICENSES.md",
        "cargo-advisories.json",
        "cargo-metadata.json",
        "frontend.cdx.json",
        "install-apt-repo.sh",
        "load-rift-repository-setup_1.0_all.deb",
        "load-rift-repository-setup_1.0_all.deb.sha256",
        "load-rift-repository-setup_1.0_all.deb.sha256.asc",
        "npm-advisories.json",
        "release.spdx.json",
    }
)
GENERATED_FILES = frozenset({"ASSET-INVENTORY.txt", "SHA256SUMS"})
VERSION_PATTERN = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?"
    r"(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$"
)


def expected_desktop_files(version: str) -> frozenset[str]:
    if not VERSION_PATTERN.fullmatch(version):
        raise ValueError(f"version must be an unprefixed semantic version: {version}")
    return frozenset(
        {
            f"Load.Rift_{version}_amd64.deb",
            f"Load.Rift-{version}-1.x86_64.rpm",
            f"Load.Rift_{version}_amd64.AppImage",
            f"Load.Rift_{version}_x64.dmg",
            f"Load.Rift_{version}_aarch64.dmg",
        }
    )


def expected_release_files(version: str) -> frozenset[str]:
    return REQUIRED_FILES | expected_desktop_files(version)


def collect_assets(root: pathlib.Path) -> dict[str, pathlib.Path]:
    if not root.is_dir():
        raise ValueError(f"release asset directory does not exist: {root}")

    assets: dict[str, pathlib.Path] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"release assets must not contain symlinks: {path}")
        if not path.is_file() or path.name in GENERATED_FILES:
            continue
        if path.name in assets:
            raise ValueError(f"duplicate release asset basename: {path.name}")
        assets[path.name] = path
    return assets


def validate_assets(assets: dict[str, pathlib.Path], version: str) -> None:
    expected = expected_release_files(version)
    missing = sorted(expected - assets.keys())
    if missing:
        raise ValueError(f"missing required release assets: {', '.join(missing)}")

    unexpected = sorted(assets.keys() - expected)
    if unexpected:
        raise ValueError(f"unexpected release assets: {', '.join(unexpected)}")


def write_manifests(root: pathlib.Path, assets: dict[str, pathlib.Path]) -> None:
    names = sorted(assets)
    (root / "ASSET-INVENTORY.txt").write_text(
        "".join(f"{name}\n" for name in names), encoding="utf-8"
    )
    checksum_lines = []
    for name in names:
        digest = hashlib.sha256(assets[name].read_bytes()).hexdigest()
        checksum_lines.append(f"{digest}  {name}\n")
    (root / "SHA256SUMS").write_text("".join(checksum_lines), encoding="utf-8")


def verify_manifests(root: pathlib.Path, assets: dict[str, pathlib.Path]) -> None:
    names = sorted(assets)
    expected_inventory = "".join(f"{name}\n" for name in names)
    inventory_path = root / "ASSET-INVENTORY.txt"
    if not inventory_path.is_file() or inventory_path.read_text(
        encoding="utf-8"
    ) != expected_inventory:
        raise ValueError("asset inventory does not exactly match release assets")

    checksum_path = root / "SHA256SUMS"
    if not checksum_path.is_file():
        raise ValueError("missing SHA256SUMS")
    checksum_lines = checksum_path.read_text(encoding="utf-8").splitlines()
    if len(checksum_lines) != len(names):
        raise ValueError("checksum manifest does not exactly match release assets")

    seen: set[str] = set()
    for line in checksum_lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([^/\n]+)", line)
        if match is None:
            raise ValueError(f"malformed checksum line: {line}")
        digest, name = match.groups()
        if name in seen or name not in assets:
            raise ValueError(f"unexpected or duplicate checksum asset: {name}")
        seen.add(name)
        actual_digest = hashlib.sha256(assets[name].read_bytes()).hexdigest()
        if digest != actual_digest:
            raise ValueError(f"checksum mismatch for release asset: {name}")

    if sorted(seen) != names:
        raise ValueError("checksum manifest does not exactly match release assets")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate a complete Load Rift release asset directory."
    )
    parser.add_argument("--version", required=True)
    parser.add_argument("directory", type=pathlib.Path)
    args = parser.parse_args()

    root = args.directory.resolve()
    assets = collect_assets(root)
    validate_assets(assets, args.version)
    write_manifests(root, assets)
    verify_manifests(root, assets)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
