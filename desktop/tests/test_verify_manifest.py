"""Manifest verification, exercised on synthetic artifacts.

The real Authenticode check needs Windows and a real signed binary; these tests
cover the manifest/file contract, channel separation and signature claims.

    python -m unittest discover -s desktop/tests -t desktop -v
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

DESKTOP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DESKTOP))

import release_config as rc  # noqa: E402
import verify  # noqa: E402


class ManifestCase(unittest.TestCase):
    def setUp(self):
        self._folder = tempfile.TemporaryDirectory()
        self.folder = Path(self._folder.name)
        self.artifact = self.folder / rc.installer_name(rc.DEVELOPMENT)
        self.artifact.write_bytes(b"not a real installer, only bytes for hashing")
        self.digest = hashlib.sha256(self.artifact.read_bytes()).hexdigest()

    def tearDown(self):
        self._folder.cleanup()

    def write_manifest(self, channel: str, **overrides) -> Path:
        manifest = {
            "product": "Paradox Desktop Agent",
            "version": "1.2.0",
            "file": rc.installer_name(channel),
            "os": "Windows 10/11",
            "architecture": "x64",
            "sha256": self.digest,
            "bytes": self.artifact.stat().st_size,
            "releasedAt": "2026-10-23T10:00:00.000Z",
            "minimumAppVersion": "1.2.0",
            "channel": channel,
            "signed": False,
            "signature": {"status": "unsigned"},
        }
        manifest.update(overrides)
        path = self.folder / rc.manifest_name(channel)
        path.write_text(json.dumps(manifest), encoding="utf-8")
        (self.folder / f"{manifest['file']}.sha256").write_text(
            f"{manifest['sha256']}  {manifest['file']}\n", encoding="ascii"
        )
        return path

    def check(self, channel: str, manifest_path: Path, **kwargs) -> list[str]:
        report = verify.Report()
        verify.verify_manifest(
            report,
            channel,
            manifest_path,
            self.folder,
            expected_publisher=kwargs.get("expected_publisher"),
        )
        return report.failures


class DevelopmentManifestTests(ManifestCase):
    def test_a_correct_development_manifest_passes(self):
        path = self.write_manifest(rc.DEVELOPMENT)
        self.assertEqual(self.check(rc.DEVELOPMENT, path), [])

    def test_a_tampered_artifact_is_caught(self):
        path = self.write_manifest(rc.DEVELOPMENT)
        self.artifact.write_bytes(b"changed after the manifest was written")
        failures = self.check(rc.DEVELOPMENT, path)
        self.assertTrue(any("SHA-256" in failure for failure in failures), failures)

    def test_a_missing_manifest_is_reported(self):
        failures = self.check(rc.DEVELOPMENT, self.folder / "nope.json")
        self.assertTrue(any("exists" in failure for failure in failures), failures)

    def test_invalid_json_is_reported(self):
        path = self.folder / rc.manifest_name(rc.DEVELOPMENT)
        path.write_text("{ not json", encoding="utf-8")
        failures = self.check(rc.DEVELOPMENT, path)
        self.assertTrue(any("valid JSON" in failure for failure in failures), failures)

    def test_a_development_manifest_cannot_be_verified_as_production(self):
        path = self.write_manifest(rc.DEVELOPMENT)
        failures = self.check(rc.PRODUCTION, path)
        self.assertTrue(any("declares channel" in failure for failure in failures), failures)
        self.assertTrue(
            any("trusted signature" in failure for failure in failures), failures
        )


class ProductionManifestTests(ManifestCase):
    def test_an_unsigned_production_manifest_fails(self):
        path = self.write_manifest(rc.PRODUCTION)
        failures = self.check(rc.PRODUCTION, path)
        self.assertTrue(
            any("trusted signature" in failure for failure in failures), failures
        )

    def test_a_self_signed_production_manifest_fails(self):
        path = self.write_manifest(
            rc.PRODUCTION,
            signed=True,
            signature={
                "status": "self-signed",
                "subject": "CN=Paradox Desktop Agent (Development), O=Paradox",
            },
        )
        failures = self.check(rc.PRODUCTION, path)
        self.assertTrue(
            any("trusted signature" in failure for failure in failures), failures
        )

    def test_the_wrong_publisher_fails(self):
        path = self.write_manifest(
            rc.PRODUCTION,
            signed=True,
            signature={
                "status": "verified",
                "subject": "CN=Otra Empresa SL",
            },
        )
        failures = self.check(
            rc.PRODUCTION, path, expected_publisher="Paradox Technologies SL"
        )
        self.assertTrue(
            any("signer is the expected publisher" in failure for failure in failures),
            failures,
        )

    def test_the_expected_publisher_passes_the_identity_check(self):
        path = self.write_manifest(
            rc.PRODUCTION,
            signed=True,
            signature={
                "status": "verified",
                "subject": "CN=Paradox Technologies SL, O=Paradox Technologies SL",
            },
        )
        failures = self.check(
            rc.PRODUCTION, path, expected_publisher="Paradox Technologies SL"
        )
        self.assertFalse(
            any("signer is the expected publisher" in failure for failure in failures),
            failures,
        )

    def test_the_wrong_installer_name_is_refused(self):
        path = self.write_manifest(rc.PRODUCTION, file=rc.installer_name(rc.DEVELOPMENT))
        failures = self.check(rc.PRODUCTION, path)
        self.assertTrue(
            any("names this channel's installer" in failure for failure in failures),
            failures,
        )


class DownloadUrlTests(ManifestCase):
    def test_a_placeholder_download_url_is_refused(self):
        path = self.write_manifest(
            rc.DEVELOPMENT, url="https://example.com/ParadoxSetup-dev.exe"
        )
        failures = self.check(rc.DEVELOPMENT, path)
        self.assertTrue(
            any("download URL is a real https URL" in failure for failure in failures),
            failures,
        )


if __name__ == "__main__":
    unittest.main()
