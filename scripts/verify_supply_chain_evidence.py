#!/usr/bin/env python3
"""Generate and validate credential-free release supply-chain evidence."""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import pathlib
import shutil
import subprocess
import tempfile
from typing import Any

if __package__:
    from scripts import verify_release_assets
else:
    import verify_release_assets


ROOT = pathlib.Path(__file__).resolve().parents[1]
EVIDENCE_FILES = frozenset(
    {
        "LICENSE",
        "THIRD_PARTY_LICENSES.md",
        "cargo-advisories.json",
        "cargo-metadata.json",
        "frontend.cdx.json",
        "npm-advisories.json",
    }
)
JSON_COMMANDS = {
    "frontend.cdx.json": (
        "npm",
        "sbom",
        "--sbom-format",
        "cyclonedx",
        "--sbom-type",
        "application",
    ),
    "npm-advisories.json": ("npm", "audit", "--audit-level=high", "--json"),
    "cargo-metadata.json": (
        "cargo",
        "metadata",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--format-version",
        "1",
    ),
    "cargo-advisories.json": (
        "cargo",
        "audit",
        "--file",
        "src-tauri/Cargo.lock",
        "--deny",
        "unsound",
        "--json",
    ),
}


def load_json_object(path: pathlib.Path) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError(f"missing or empty JSON evidence: {path.name}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"malformed JSON evidence: {path.name}: {error}") from error
    if not isinstance(value, dict) or not value:
        raise ValueError(f"JSON evidence must be a nonempty object: {path.name}")
    return value


def validate_evidence(root: pathlib.Path) -> None:
    for name in ("LICENSE", "THIRD_PARTY_LICENSES.md"):
        path = root / name
        if not path.is_file() or not path.read_text(encoding="utf-8").strip():
            raise ValueError(f"missing or empty license evidence: {name}")

    frontend = load_json_object(root / "frontend.cdx.json")
    if (
        frontend.get("bomFormat") != "CycloneDX"
        or not isinstance(frontend.get("components"), list)
        or not frontend["components"]
    ):
        raise ValueError("frontend.cdx.json is not a nonempty CycloneDX SBOM")

    npm_audit = load_json_object(root / "npm-advisories.json")
    npm_metadata = npm_audit.get("metadata")
    if (
        not isinstance(npm_audit.get("auditReportVersion"), int)
        or not isinstance(npm_metadata, dict)
        or not isinstance(npm_metadata.get("vulnerabilities"), dict)
    ):
        raise ValueError("npm-advisories.json is not an npm audit report")

    cargo_metadata = load_json_object(root / "cargo-metadata.json")
    if (
        not isinstance(cargo_metadata.get("packages"), list)
        or not cargo_metadata["packages"]
        or not isinstance(cargo_metadata.get("resolve"), dict)
    ):
        raise ValueError("cargo-metadata.json is not nonempty Cargo metadata")

    cargo_audit = load_json_object(root / "cargo-advisories.json")
    if not all(
        key in cargo_audit
        for key in ("database", "lockfile", "vulnerabilities", "warnings")
    ):
        raise ValueError("cargo-advisories.json is not a cargo-audit report")


def validate_spdx(path: pathlib.Path) -> None:
    document = load_json_object(path)
    represented_items = document.get("files") or document.get("packages")
    if (
        document.get("spdxVersion") != "SPDX-2.3"
        or document.get("SPDXID") != "SPDXRef-DOCUMENT"
        or not isinstance(document.get("creationInfo"), dict)
        or not isinstance(represented_items, list)
        or not represented_items
    ):
        raise ValueError(f"{path.name} is not a nonempty SPDX 2.3 document")


def generate_evidence(output: pathlib.Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError(f"evidence output directory must be empty: {output}")

    for name, command in JSON_COMMANDS.items():
        result = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            raise RuntimeError(f"{' '.join(command)} failed: {detail}")
        (output / name).write_text(result.stdout, encoding="utf-8")

    shutil.copyfile(ROOT / "LICENSE", output / "LICENSE")
    shutil.copyfile(
        ROOT / "THIRD_PARTY_LICENSES.md", output / "THIRD_PARTY_LICENSES.md"
    )
    if {path.name for path in output.iterdir()} != EVIDENCE_FILES:
        raise ValueError("generated evidence set is not exact")
    validate_evidence(output)


def project_version() -> str:
    package_version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))[
        "version"
    ]
    tauri_version = json.loads(
        (ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
    )["version"]
    cargo_version = next(
        line.split("=", 1)[1].strip().strip('"')
        for line in (ROOT / "src-tauri" / "Cargo.toml")
        .read_text(encoding="utf-8")
        .splitlines()
        if line.startswith("version = ")
    )
    if len({package_version, tauri_version, cargo_version}) != 1:
        raise ValueError("package, Tauri, and Cargo versions must match")
    verify_release_assets.expected_desktop_files(package_version)
    return package_version


def create_representative_assets(root: pathlib.Path, version: str) -> None:
    expected = verify_release_assets.expected_release_files(version)
    for name in sorted(expected - EVIDENCE_FILES - {"release.spdx.json"}):
        path = root / name
        if name == "install-apt-repo.sh":
            shutil.copyfile(ROOT / "scripts" / name, path)
        else:
            path.write_text(f"local representative for {name}\n", encoding="utf-8")


def write_representative_spdx(root: pathlib.Path, version: str) -> None:
    paths = sorted(
        path
        for path in root.iterdir()
        if path.is_file()
        and path.name not in verify_release_assets.GENERATED_FILES
        and path.name != "release.spdx.json"
    )
    namespace_seed = "\n".join(
        f"{path.name}:{hashlib.sha256(path.read_bytes()).hexdigest()}" for path in paths
    )
    namespace_hash = hashlib.sha256(namespace_seed.encode("utf-8")).hexdigest()
    document = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"Load Rift {version} local representative release",
        "documentNamespace": (
            "https://github.com/ddv1982/load-rift/spdx/local/" + namespace_hash
        ),
        "creationInfo": {
            "created": datetime.datetime.now(datetime.timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
            "creators": ["Tool: scripts/verify_supply_chain_evidence.py"],
        },
        "files": [
            {
                "fileName": f"./{path.name}",
                "SPDXID": f"SPDXRef-File-{index}",
                "checksums": [
                    {
                        "algorithm": "SHA256",
                        "checksumValue": hashlib.sha256(path.read_bytes()).hexdigest(),
                    }
                ],
                "licenseConcluded": "NOASSERTION",
                "copyrightText": "NOASSERTION",
            }
            for index, path in enumerate(paths, start=1)
        ],
    }
    (root / "release.spdx.json").write_text(
        json.dumps(document, indent=2) + "\n", encoding="utf-8"
    )


def validate_release_directory(root: pathlib.Path, version: str) -> None:
    assets = verify_release_assets.collect_assets(root)
    verify_release_assets.validate_assets(assets, version)
    validate_evidence(root)
    validate_spdx(root / "release.spdx.json")
    verify_release_assets.verify_manifests(root, assets)


def local_check() -> None:
    version = project_version()
    with tempfile.TemporaryDirectory(prefix="load-rift-release-evidence-") as directory:
        root = pathlib.Path(directory)
        generate_evidence(root)
        create_representative_assets(root, version)
        write_representative_spdx(root, version)
        assets = verify_release_assets.collect_assets(root)
        verify_release_assets.validate_assets(assets, version)
        verify_release_assets.write_manifests(root, assets)
        validate_release_directory(root, version)
    print(f"Validated credential-free release evidence for Load Rift {version}.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate_parser = subparsers.add_parser("generate")
    generate_parser.add_argument("--output", required=True, type=pathlib.Path)

    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--version", required=True)
    validate_parser.add_argument("directory", type=pathlib.Path)

    subparsers.add_parser("local-check")
    args = parser.parse_args()

    if args.command == "generate":
        generate_evidence(args.output.resolve())
    elif args.command == "validate":
        validate_release_directory(args.directory.resolve(), args.version)
    else:
        local_check()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
