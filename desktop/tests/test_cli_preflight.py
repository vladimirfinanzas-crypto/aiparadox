"""The preflight of both channels, exercised through the real command line.

    python -m unittest discover -s desktop/tests -t desktop -v

These tests never build anything: `--check` validates the configuration and
exits, which is exactly what CI runs before a runner spends twenty minutes.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

DESKTOP = Path(__file__).resolve().parents[1]
ROOT = DESKTOP.parent


def clean_env(**overrides: str) -> dict[str, str]:
    """A minimal environment: no certificate leaks in from the machine."""
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("PARADOX_", "WINDOWS_CERT"))
    }
    env.update(overrides)
    return env


def run_check(*args: str, **env: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(DESKTOP / "package.py"), "--check", *args],
        cwd=str(ROOT),
        text=True,
        capture_output=True,
        env=clean_env(**env),
        timeout=120,
    )


class DevelopmentPreflight(unittest.TestCase):
    def test_passes_with_a_local_server_and_no_certificate(self):
        result = run_check("--channel", "development", "--api", "http://localhost:3000")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Configuration valid", result.stdout)
        self.assertIn("Nothing was built", result.stdout)
        self.assertIn("ParadoxSetup-dev.exe", result.stdout)

    def test_refuses_a_placeholder_server(self):
        result = run_check("--channel", "development", "--api", "https://app.paradox.example")
        self.assertEqual(result.returncode, 2)
        self.assertIn("placeholder", result.stderr)

    def test_refuses_plain_http_off_the_machine(self):
        result = run_check("--channel", "development", "--api", "http://staging.midominio.dev")
        self.assertEqual(result.returncode, 2)
        self.assertIn("https", result.stderr)


class ProductionPreflight(unittest.TestCase):
    def test_fails_without_a_certificate(self):
        result = run_check(
            "--channel",
            "production",
            "--version",
            "1.2.0",
            "--api",
            "https://app.midominio.com",
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("certificate", result.stderr)
        self.assertNotIn("Configuration valid", result.stdout)

    def test_fails_when_the_certificate_file_is_missing(self):
        result = run_check(
            "--channel",
            "production",
            "--version",
            "1.2.0",
            "--api",
            "https://app.midominio.com",
            PARADOX_SIGN_PFX="C:/no/existe/certificado.pfx",
            PARADOX_SIGN_PASSWORD="secreto",
            PARADOX_SIGN_PUBLISHER="CN=Paradox Technologies SL",
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("does not exist", result.stderr)

    def test_passes_with_a_certificate_and_a_production_url(self):
        with tempfile.TemporaryDirectory() as folder:
            pfx = Path(folder) / "certificate.pfx"
            pfx.write_bytes(b"not a real certificate: only its presence is checked here")
            result = run_check(
                "--channel",
                "production",
                "--version",
                "1.2.0",
                "--api",
                "https://app.midominio.com",
                PARADOX_SIGN_PFX=str(pfx),
                PARADOX_SIGN_PASSWORD="secreto",
                PARADOX_SIGN_PUBLISHER="CN=Paradox Technologies SL",
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Configuration valid", result.stdout)
        self.assertIn("ParadoxSetup.exe", result.stdout)

    def test_fails_with_a_local_or_empty_server(self):
        for url in ("", "http://localhost:3000", "https://192.168.1.20"):
            result = run_check(
                "--channel",
                "production",
                "--version",
                "1.2.0",
                "--api",
                url,
            )
            self.assertEqual(result.returncode, 2, url)
            self.assertIn("configuration error", result.stderr)

    def test_fails_without_a_publisher_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            pfx = Path(folder) / "certificate.pfx"
            pfx.write_bytes(b"placeholder")
            result = run_check(
                "--channel",
                "production",
                "--version",
                "1.2.0",
                "--api",
                "https://app.midominio.com",
                PARADOX_SIGN_PFX=str(pfx),
                PARADOX_SIGN_PASSWORD="secreto",
            )
        self.assertEqual(result.returncode, 2)
        self.assertIn("PARADOX_SIGN_PUBLISHER", result.stderr)

    def test_refuses_a_test_certificate(self):
        result = run_check(
            "--channel",
            "production",
            "--version",
            "1.2.0",
            "--api",
            "https://app.midominio.com",
            "--self-sign",
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("test certificate", result.stderr)


class VerifyPreflight(unittest.TestCase):
    def test_verify_fails_when_nothing_is_published(self):
        with tempfile.TemporaryDirectory() as folder:
            result = subprocess.run(
                [
                    sys.executable,
                    str(DESKTOP / "verify.py"),
                    "--channel",
                    "production",
                    "--artifacts",
                    folder,
                    "--skip-artifacts",
                ],
                cwd=str(ROOT),
                text=True,
                capture_output=True,
                env=clean_env(),
                timeout=120,
            )
        self.assertEqual(result.returncode, 1)
        self.assertIn("desktop.json", result.stdout)
        self.assertIn("failed", result.stdout)


if __name__ == "__main__":
    unittest.main()
