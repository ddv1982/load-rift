import hashlib
import json
import pathlib
import re
import tempfile
import unittest

from scripts import verify_release_assets
from scripts import verify_supply_chain_evidence


ROOT = pathlib.Path(__file__).resolve().parents[1]


class SupplyChainPolicyTests(unittest.TestCase):
    def test_all_workflow_actions_are_pinned_to_full_shas(self) -> None:
        action_pattern = re.compile(r"^\s*-?\s*uses:\s*[^\s@]+@([^\s#]+)", re.MULTILINE)
        for workflow in sorted((ROOT / ".github" / "workflows").glob("*.yml")):
            with self.subTest(workflow=workflow.name):
                references = action_pattern.findall(workflow.read_text(encoding="utf-8"))
                self.assertTrue(references, "workflow must use at least one pinned action")
                for reference in references:
                    self.assertRegex(reference, r"^[0-9a-f]{40}$")

    def test_canonical_and_hosted_gates_cover_audits_coverage_and_policy(self) -> None:
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        verify = package["scripts"]["verify"]
        for command in (
            "npm run audit:npm",
            "npm run test:coverage",
            "npm run test:apt",
            "npm run test:supply-chain",
            "npm run evidence:supply-chain",
            "npm run rust:audit",
        ):
            self.assertIn(command, verify)

        for workflow_name in ("ci.yml", "release.yml"):
            workflow = (ROOT / ".github" / "workflows" / workflow_name).read_text(
                encoding="utf-8"
            )
            with self.subTest(workflow=workflow_name):
                self.assertEqual(workflow.count("run: npm run verify"), 1)
                self.assertIn('LOADRIFT_REQUIRE_BUNDLED_K6_TESTS: "true"', workflow)

    def test_ci_runtime_and_lockfile_policy_is_explicit(self) -> None:
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(
            encoding="utf-8"
        )
        release = (ROOT / ".github" / "workflows" / "release.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn("runs-on: ubuntu-24.04", ci)
        self.assertNotIn("ubuntu-22.04", ci)
        self.assertEqual(
            re.findall(r"node-version:\s*(\S+)", ci + release),
            ["24", "24", "24"],
        )
        self.assertEqual(
            re.findall(r"toolchain:\s*(\S+)", ci + release),
            ["1.97.1", "1.97.1", "1.97.1"],
        )
        self.assertEqual(
            re.findall(r"- platform: (ubuntu-[0-9.]+)", release), ["ubuntu-22.04"]
        )
        self.assertEqual(
            re.findall(r"runs-on: (ubuntu-[0-9.]+)", release),
            ["ubuntu-24.04"] * 6,
        )
        self.assertIn(
            "npm run tauri -- build ${{ matrix.args }} -- --locked", release
        )

        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        for script_name in (
            "test:workflow-smoke",
            "benchmark:large-collection",
            "rust:clippy",
            "verify",
        ):
            with self.subTest(script=script_name):
                self.assertIn("--locked", package["scripts"][script_name])

    def test_rust_unsound_policy_has_one_documented_exception(self) -> None:
        audit_policy = (ROOT / ".cargo" / "audit.toml").read_text(encoding="utf-8")
        ignored = re.findall(r'"(RUSTSEC-\d{4}-\d{4})"', audit_policy)
        self.assertEqual(ignored, ["RUSTSEC-2024-0429"])
        self.assertIn("Linux Tauri 2", audit_policy)
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertIn("--deny unsound", package["scripts"]["rust:audit"])

    def test_targeted_lockfile_remediations_are_exact(self) -> None:
        package_lock = json.loads(
            (ROOT / "package-lock.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            package_lock["packages"]["node_modules/brace-expansion"]["version"],
            "5.0.7",
        )
        cargo_lock = (ROOT / "src-tauri" / "Cargo.lock").read_text(encoding="utf-8")
        self.assertRegex(
            cargo_lock,
            r'\[\[package\]\]\nname = "anyhow"\nversion = "1\.0\.104"',
        )

    def test_tauri_resources_exclude_interrupted_k6_staging_files(self) -> None:
        config = json.loads(
            (ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
        )
        resources = config["bundle"]["resources"]
        self.assertEqual(
            resources,
            [
                "bin/[Rk]*",
                "../LICENSE",
                "../THIRD_PARTY_LICENSES.md",
                "../licenses/AGPL-3.0.txt",
            ],
        )

    def test_release_publication_depends_on_complete_evidence(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(
            encoding="utf-8"
        )
        for required in (
            "anchore/sbom-action@",
            "actions/attest@",
            "scripts/verify_release_assets.py",
            "ASSET-INVENTORY.txt",
            "SHA256SUMS",
            "release-verification-evidence",
            "needs: [resolve-release, create-release, publish-tauri, verify]",
        ):
            self.assertIn(required, workflow)
        publish_job = workflow.split("  publish-release:\n", 1)[1]
        self.assertIn("publish-release-assets", publish_job)

    def test_workflow_passes_version_derived_from_verified_tag(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(
            encoding="utf-8"
        )
        validation_step = workflow.split(
            "      - name: Validate inventory and generate release-wide checksums\n", 1
        )[1].split("\n      - name:", 1)[0]
        self.assertIn(
            "TAG_NAME: ${{ needs.resolve-release.outputs.tag_name }}", validation_step
        )
        self.assertIn('release_version="${TAG_NAME#v}"', validation_step)
        self.assertIn('[[ "v${release_version}" == "$TAG_NAME" ]]', validation_step)
        self.assertIn(
            'scripts/verify_release_assets.py --version "$release_version" release-assets',
            validation_step,
        )

    def test_evidence_validation_precedes_attestation_and_upload(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(
            encoding="utf-8"
        )
        publish_assets = workflow.split("  publish-release-assets:\n", 1)[1].split(
            "\n  deploy-apt-pages:", 1
        )[0]
        inventory = publish_assets.index("scripts/verify_release_assets.py")
        evidence = publish_assets.index("verify_supply_chain_evidence.py validate")
        attestation = publish_assets.index("uses: actions/attest@")
        upload = publish_assets.index('gh release upload "$TAG_NAME"')
        self.assertLess(inventory, evidence)
        self.assertLess(evidence, attestation)
        self.assertLess(attestation, upload)

    def test_evidence_command_uses_real_ecosystem_generators(self) -> None:
        self.assertEqual(
            verify_supply_chain_evidence.JSON_COMMANDS["frontend.cdx.json"],
            (
                "npm",
                "sbom",
                "--sbom-format",
                "cyclonedx",
                "--sbom-type",
                "application",
            ),
        )
        self.assertEqual(
            verify_supply_chain_evidence.JSON_COMMANDS["npm-advisories.json"][:2],
            ("npm", "audit"),
        )
        self.assertEqual(
            verify_supply_chain_evidence.JSON_COMMANDS["cargo-metadata.json"][:2],
            ("cargo", "metadata"),
        )
        self.assertEqual(
            verify_supply_chain_evidence.JSON_COMMANDS["cargo-advisories.json"][:2],
            ("cargo", "audit"),
        )

    def test_readme_attestation_loop_is_null_delimited_and_fail_fast(self) -> None:
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        verification_block = readme.split(
            "After downloading all assets, verify their inventory and checksums with:\n\n",
            1,
        )[1].split("```", 2)[1]
        self.assertIn("set -euo pipefail", verification_block)
        self.assertIn("find . -type f -print0", verification_block)
        self.assertIn("sort -z", verification_block)
        self.assertIn("while IFS= read -r -d '' asset; do", verification_block)
        self.assertIn(
            'gh attestation verify --repo ddv1982/load-rift "$asset"',
            verification_block,
        )
        self.assertNotIn("./*", verification_block)
        self.assertLess(
            verification_block.index("sha256sum -c SHA256SUMS"),
            verification_block.index("gh attestation verify"),
        )


class ReleaseAssetManifestTests(unittest.TestCase):
    VERSION = "1.2.3"

    def make_complete_assets(
        self, root: pathlib.Path, version: str = VERSION
    ) -> None:
        for name in verify_release_assets.expected_release_files(version):
            (root / name).write_text(name, encoding="utf-8")

    def test_complete_inventory_and_checksums_are_sorted_and_exact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_complete_assets(root)

            assets = verify_release_assets.collect_assets(root)
            verify_release_assets.validate_assets(assets, self.VERSION)
            verify_release_assets.write_manifests(root, assets)
            verify_release_assets.verify_manifests(root, assets)

            inventory = (root / "ASSET-INVENTORY.txt").read_text(
                encoding="utf-8"
            ).splitlines()
            self.assertEqual(inventory, sorted(assets))
            checksum_lines = (root / "SHA256SUMS").read_text(
                encoding="utf-8"
            ).splitlines()
            self.assertEqual([line.split("  ", 1)[1] for line in checksum_lines], inventory)
            for line in checksum_lines:
                digest, name = line.split("  ", 1)
                self.assertEqual(digest, hashlib.sha256(assets[name].read_bytes()).hexdigest())

    def test_exact_current_version_and_product_names_are_required(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_complete_assets(root, "1.2.2")
            with self.assertRaisesRegex(ValueError, "missing required"):
                verify_release_assets.validate_assets(
                    verify_release_assets.collect_assets(root), self.VERSION
                )

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_complete_assets(root)
            expected = root / f"Load.Rift_{self.VERSION}_amd64.deb"
            expected.rename(root / f"Load.Raft_{self.VERSION}_amd64.deb")
            with self.assertRaisesRegex(ValueError, "missing required"):
                verify_release_assets.validate_assets(
                    verify_release_assets.collect_assets(root), self.VERSION
                )

    def test_duplicate_dmg_architecture_cannot_replace_the_other(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_complete_assets(root)
            (root / f"Load.Rift_{self.VERSION}_aarch64.dmg").unlink()
            (root / f"Load.Rift_{self.VERSION}_x64-copy.dmg").write_text(
                "duplicate x64", encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "missing required"):
                verify_release_assets.validate_assets(
                    verify_release_assets.collect_assets(root), self.VERSION
                )

    def test_missing_extra_and_duplicate_assets_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_complete_assets(root)
            (root / "LICENSE").unlink()
            with self.assertRaisesRegex(ValueError, "missing required"):
                verify_release_assets.validate_assets(
                    verify_release_assets.collect_assets(root), self.VERSION
                )

            (root / "LICENSE").write_text("license", encoding="utf-8")
            (root / "unexpected.zip").write_text("extra", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unexpected release assets"):
                verify_release_assets.validate_assets(
                    verify_release_assets.collect_assets(root), self.VERSION
                )

            (root / "unexpected.zip").unlink()
            nested = root / "nested"
            nested.mkdir()
            (nested / "LICENSE").write_text("duplicate", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate release asset basename"):
                verify_release_assets.collect_assets(root)

    def test_modified_asset_fails_existing_checksum_verification(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_complete_assets(root)
            assets = verify_release_assets.collect_assets(root)
            verify_release_assets.validate_assets(assets, self.VERSION)
            verify_release_assets.write_manifests(root, assets)
            assets[f"Load.Rift_{self.VERSION}_amd64.AppImage"].write_text(
                "substituted binary", encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                verify_release_assets.verify_manifests(root, assets)

    def test_bad_checksum_entry_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_complete_assets(root)
            assets = verify_release_assets.collect_assets(root)
            verify_release_assets.write_manifests(root, assets)
            checksum_path = root / "SHA256SUMS"
            lines = checksum_path.read_text(encoding="utf-8").splitlines()
            _, name = lines[0].split("  ", 1)
            lines[0] = f"{'0' * 64}  {name}"
            checksum_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                verify_release_assets.verify_manifests(root, assets)


class ReleaseEvidenceTests(unittest.TestCase):
    def make_valid_evidence(self, root: pathlib.Path) -> None:
        (root / "LICENSE").write_text("project license", encoding="utf-8")
        (root / "THIRD_PARTY_LICENSES.md").write_text(
            "third-party notices", encoding="utf-8"
        )
        documents = {
            "frontend.cdx.json": {
                "bomFormat": "CycloneDX",
                "components": [{"name": "react"}],
            },
            "npm-advisories.json": {
                "auditReportVersion": 2,
                "metadata": {"vulnerabilities": {"total": 0}},
            },
            "cargo-metadata.json": {
                "packages": [{"name": "loadrift"}],
                "resolve": {"root": "loadrift"},
            },
            "cargo-advisories.json": {
                "database": {},
                "lockfile": {},
                "vulnerabilities": {},
                "warnings": {},
            },
        }
        for name, document in documents.items():
            (root / name).write_text(json.dumps(document), encoding="utf-8")

    def test_malformed_empty_and_substituted_evidence_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_valid_evidence(root)
            (root / "frontend.cdx.json").write_text("{", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "malformed JSON evidence"):
                verify_supply_chain_evidence.validate_evidence(root)

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_valid_evidence(root)
            (root / "cargo-advisories.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "nonempty object"):
                verify_supply_chain_evidence.validate_evidence(root)

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_valid_evidence(root)
            (root / "LICENSE").write_text("", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "empty license evidence"):
                verify_supply_chain_evidence.validate_evidence(root)

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_valid_evidence(root)
            cyclonedx = (root / "frontend.cdx.json").read_text(encoding="utf-8")
            (root / "cargo-metadata.json").write_text(cyclonedx, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "not nonempty Cargo metadata"):
                verify_supply_chain_evidence.validate_evidence(root)

    def test_empty_spdx_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "release.spdx.json"
            path.write_text(
                json.dumps(
                    {
                        "spdxVersion": "SPDX-2.3",
                        "SPDXID": "SPDXRef-DOCUMENT",
                        "creationInfo": {},
                        "files": [],
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "nonempty SPDX"):
                verify_supply_chain_evidence.validate_spdx(path)


if __name__ == "__main__":
    unittest.main()
