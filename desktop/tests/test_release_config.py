"""Validation rules for the two build channels.

    python -m unittest discover -s desktop/tests -t desktop -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

DESKTOP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DESKTOP))

import release_config as rc  # noqa: E402


class ChannelTests(unittest.TestCase):
    def test_accepts_both_names_and_their_aliases(self):
        self.assertEqual(rc.normalize_channel("development"), rc.DEVELOPMENT)
        self.assertEqual(rc.normalize_channel("dev"), rc.DEVELOPMENT)
        self.assertEqual(rc.normalize_channel("production"), rc.PRODUCTION)
        self.assertEqual(rc.normalize_channel("release"), rc.PRODUCTION)
        self.assertEqual(rc.normalize_channel(" PRODUCTION "), rc.PRODUCTION)

    def test_rejects_unknown_channels(self):
        with self.assertRaises(rc.ConfigError):
            rc.normalize_channel("staging")
        with self.assertRaises(rc.ConfigError):
            rc.normalize_channel(None)

    def test_each_channel_has_its_own_files(self):
        self.assertEqual(rc.installer_name(rc.DEVELOPMENT), "ParadoxSetup-dev.exe")
        self.assertEqual(rc.installer_name(rc.PRODUCTION), "ParadoxSetup.exe")
        self.assertEqual(rc.manifest_name(rc.DEVELOPMENT), "desktop-dev.json")
        self.assertEqual(rc.manifest_name(rc.PRODUCTION), "desktop.json")


class VersionTests(unittest.TestCase):
    def test_requires_major_minor_patch(self):
        self.assertEqual(rc.validate_version("1.2.0", rc.DEVELOPMENT), "1.2.0")
        for bad in ("1.2", "v1.2.0", "1.2.0.0", "", "latest"):
            with self.assertRaises(rc.ConfigError, msg=bad):
                rc.validate_version(bad, rc.DEVELOPMENT)

    def test_production_cannot_publish_a_zero_version(self):
        with self.assertRaises(rc.ConfigError):
            rc.validate_version("0.9.0", rc.PRODUCTION)
        self.assertEqual(rc.validate_version("1.0.0", rc.PRODUCTION), "1.0.0")


class ApiUrlTests(unittest.TestCase):
    def test_development_accepts_a_local_server(self):
        self.assertEqual(
            rc.validate_api_url("http://localhost:3000", rc.DEVELOPMENT),
            "http://localhost:3000",
        )
        self.assertEqual(
            rc.validate_api_url("http://127.0.0.1:3000/", rc.DEVELOPMENT),
            "http://127.0.0.1:3000",
        )

    def test_development_accepts_https_anywhere_real(self):
        self.assertEqual(
            rc.validate_api_url("https://staging.midominio.dev/", rc.DEVELOPMENT),
            "https://staging.midominio.dev",
        )

    def test_development_rejects_plain_http_off_the_machine(self):
        with self.assertRaises(rc.ConfigError):
            rc.validate_api_url("http://staging.midominio.dev", rc.DEVELOPMENT)

    def test_no_channel_accepts_a_placeholder_domain(self):
        # A localhost build is legitimate in development (tested above); these
        # are the values that must never be built against in any channel.
        for url in (
            "https://app.paradox.example",
            "https://example.com",
            "https://example.org",
            "https://paradox.test",
            "https://mi-app.invalid",
        ):
            with self.assertRaises(rc.ConfigError, msg=url):
                rc.validate_api_url(url, rc.DEVELOPMENT)

    def test_production_rejects_empty_local_or_plain_http(self):
        for url in (
            "",
            "http://app.midominio.com",
            "https://localhost",
            "https://127.0.0.1",
            "https://192.168.1.10",
            "https://10.0.0.4",
            "https://app.midominio.local",
        ):
            with self.assertRaises(rc.ConfigError, msg=url):
                rc.validate_api_url(url, rc.PRODUCTION)

    def test_production_accepts_a_real_https_host(self):
        self.assertEqual(
            rc.validate_api_url("https://app.midominio.com/", rc.PRODUCTION),
            "https://app.midominio.com",
        )

    def test_rejects_credentials_in_the_url(self):
        with self.assertRaises(rc.ConfigError):
            rc.validate_api_url("https://user:pass@app.midominio.com", rc.PRODUCTION)

    def test_empty_url_explains_where_to_set_it(self):
        with self.assertRaises(rc.ConfigError) as caught:
            rc.validate_api_url("", rc.PRODUCTION)
        self.assertIn("PARADOX_API_URL", str(caught.exception))


class DownloadUrlTests(unittest.TestCase):
    def test_optional_but_https_when_present(self):
        self.assertIsNone(rc.validate_download_url(None))
        self.assertEqual(
            rc.validate_download_url("https://releases.midominio.com/setup.exe"),
            "https://releases.midominio.com/setup.exe",
        )
        with self.assertRaises(rc.ConfigError):
            rc.validate_download_url("http://releases.midominio.com/setup.exe")
        with self.assertRaises(rc.ConfigError):
            rc.validate_download_url("https://example.com/setup.exe")


class SigningTests(unittest.TestCase):
    def test_development_needs_nothing(self):
        plan = rc.signing_requirements(rc.DEVELOPMENT, {})
        self.assertFalse(plan["required"])
        self.assertTrue(plan["allow_test_certificate"])

    def test_production_without_certificate_fails(self):
        with self.assertRaises(rc.ConfigError) as caught:
            rc.signing_requirements(rc.PRODUCTION, {})
        self.assertIn("PARADOX_SIGN_PFX", str(caught.exception))

    def test_production_without_publisher_fails(self):
        with self.assertRaises(rc.ConfigError) as caught:
            rc.signing_requirements(
                rc.PRODUCTION,
                {"PARADOX_SIGN_PFX": "cert.pfx", "PARADOX_SIGN_PASSWORD": "x"},
            )
        self.assertIn("PARADOX_SIGN_PUBLISHER", str(caught.exception))

    def test_production_without_password_fails(self):
        with self.assertRaises(rc.ConfigError):
            rc.signing_requirements(
                rc.PRODUCTION,
                {"PARADOX_SIGN_PFX": "cert.pfx", "PARADOX_SIGN_PUBLISHER": "Paradox SL"},
            )

    def test_production_complete_configuration_passes(self):
        plan = rc.signing_requirements(
            rc.PRODUCTION,
            {
                "PARADOX_SIGN_PFX": "cert.pfx",
                "PARADOX_SIGN_PASSWORD": "secret",
                "PARADOX_SIGN_PUBLISHER": "Paradox Technologies SL",
            },
        )
        self.assertTrue(plan["required"])
        self.assertEqual(plan["publisher"], "Paradox Technologies SL")

    def test_thumbprint_is_an_alternative_to_a_pfx(self):
        plan = rc.signing_requirements(
            rc.PRODUCTION,
            {
                "PARADOX_SIGN_THUMBPRINT": "ABCDEF",
                "PARADOX_SIGN_PUBLISHER": "Paradox Technologies SL",
            },
        )
        self.assertTrue(plan["required"])


class PublisherTests(unittest.TestCase):
    SUBJECT = "CN=Paradox Technologies SL, O=Paradox Technologies SL, C=ES"

    def test_matches_the_subject_it_was_configured_with(self):
        self.assertTrue(rc.publisher_matches(self.SUBJECT, "Paradox Technologies SL"))
        self.assertTrue(
            rc.publisher_matches(
                self.SUBJECT, "CN=Paradox Technologies SL, O=Paradox Technologies SL"
            )
        )
        self.assertTrue(rc.publisher_matches(self.SUBJECT, "Paradox Technologies"))

    def test_never_matches_a_different_or_empty_identity(self):
        self.assertFalse(rc.publisher_matches(self.SUBJECT, "Otra Empresa SL"))
        self.assertFalse(rc.publisher_matches(self.SUBJECT, ""))
        self.assertFalse(rc.publisher_matches(None, "Paradox Technologies SL"))
        self.assertFalse(rc.publisher_matches("CN=NotParadox Ltd", "Paradox"))

    def test_a_short_expected_value_is_refused(self):
        self.assertFalse(rc.publisher_matches(self.SUBJECT, "P"))


class IntegrityTests(unittest.TestCase):
    def test_hash_changes_when_the_file_changes(self):
        import tempfile

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "artifact.bin"
            path.write_bytes(b"installer")
            first = rc.sha256_of(path)
            path.write_bytes(b"installer, tampered")
            second = rc.sha256_of(path)

        self.assertEqual(len(first), 64)
        self.assertNotEqual(first, second)


class PlanTests(unittest.TestCase):
    def test_development_plan_says_it_is_not_a_release(self):
        lines = "\n".join(
            rc.describe_plan(rc.DEVELOPMENT, "1.2.0", "http://localhost:3000", will_publish=True)
        )
        self.assertIn("development", lines)
        self.assertIn("not an official release", lines)

    def test_production_plan_reports_publication_gate(self):
        lines = "\n".join(
            rc.describe_plan(
                rc.PRODUCTION,
                "1.2.0",
                "https://app.midominio.com",
                will_publish=False,
                publisher="Paradox SL",
            )
        )
        self.assertIn("not requested", lines)
        self.assertIn("Paradox SL", lines)


if __name__ == "__main__":
    unittest.main()
