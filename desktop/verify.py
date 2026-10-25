"""
Checks a Desktop Agent build the way the web and a person would.

    python desktop/verify.py --channel development
    python desktop/verify.py --channel production
    python desktop/verify.py --channel development --install-test
    python desktop/verify.py --channel production --artifacts desktop/out/release

What it checks depends on the channel:

    development  the artifacts exist, the development manifest matches the
                 development installer (name, size, SHA-256, .sha256 file), and
                 the manifest never claims a trusted signature it does not have.
    production   everything above, plus: the manifest is the official one, the
                 signature is really verified by Windows, the certificate is the
                 expected publisher, and nothing is declared that the file
                 cannot back.

`--install-test` performs a real silent install into a temporary folder, checks
the shortcut and the Apps entry, runs the installed agent's self-test, then runs
the uninstaller and checks that everything is gone. It writes to the current
user's registry for the duration of the test and cleans up after itself.

Exit code 0 means every check passed; a non-zero code lists what failed.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:  # Windows-only, but this module is imported on other platforms for its
    # manifest checks, so the import cannot be unconditional.
    import winreg
except ImportError:  # pragma: no cover - platform dependent
    winreg = None  # type: ignore[assignment]

from release_config import (
    DEVELOPMENT,
    PRODUCTION,
    ConfigError,
    installer_name,
    manifest_name,
    normalize_channel,
    publisher_matches,
    sha256_of,
    validate_download_url,
)

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "desktop" / "dist"
DOWNLOADS = ROOT / "public" / "downloads"
STAGED = ROOT / "desktop" / "out" / "release"
APP_ID = "ParadoxDesktopAgent"
UNINSTALL_KEY = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{APP_ID}"


class Report:
    """Collects checks so a single run reports everything, not just the first failure."""

    def __init__(self) -> None:
        self.failures: list[str] = []
        self.checks = 0

    def check(self, condition: bool, label: str, detail: str = "") -> bool:
        self.checks += 1
        if condition:
            print(f"  ok    {label}")
            return True
        print(f"  FAIL  {label}{f' — {detail}' if detail else ''}")
        self.failures.append(label)
        return False

    def note(self, message: str) -> None:
        print(f"  note  {message}")


def run(command: list[str], timeout: int = 180) -> subprocess.CompletedProcess:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def describe_signature(path: Path) -> dict:
    """Reads Windows' view of the file's Authenticode signature."""
    if os.name != "nt":
        return {"status": "unknown", "windowsStatus": "not-windows"}

    script = (
        "$s = Get-AuthenticodeSignature -FilePath '{p}';"
        "[pscustomobject]@{{ Status = $s.Status.ToString();"
        " Subject = if ($s.SignerCertificate) {{ $s.SignerCertificate.Subject }} else {{ '' }};"
        " Timestamped = [bool]$s.TimeStamperCertificate }} | ConvertTo-Json -Compress"
    ).format(p=str(path).replace("'", "''"))
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True,
            text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError:
        return {"status": "unknown", "windowsStatus": "powershell-unavailable"}

    try:
        info = json.loads((result.stdout or "{}").strip() or "{}")
    except json.JSONDecodeError:
        return {"status": "unsigned", "windowsStatus": "unreadable"}

    status = str(info.get("Status") or "")
    subject = str(info.get("Subject") or "")
    if status == "HashMismatch":
        return {"status": "hash-mismatch", "windowsStatus": status}
    # Only a real signer certificate means the file is signed. Windows reports
    # states like UnknownError or NotSupportedFileFormat for unsigned files;
    # calling those "self-signed" would let an unsigned artifact look signed.
    if status in ("NotSigned", "") or not subject:
        return {"status": "unsigned", "windowsStatus": status or "NotSigned"}
    return {
        "status": "verified" if status == "Valid" else "self-signed",
        "windowsStatus": status,
        "subject": subject,
        "timestamped": bool(info.get("Timestamped")),
    }


def verify_artifacts(report: Report, channel: str) -> None:
    print("\nBinaries")
    agent = DIST / "ParadoxAgent.exe"
    setup = DIST / "ParadoxSetup.exe"

    if os.name != "nt":
        report.note("not running on Windows: skipping the executables' own checks")
        return

    report.check(agent.exists(), "ParadoxAgent.exe was built")
    report.check(setup.exists(), "ParadoxSetup.exe was built")
    if not (agent.exists() and setup.exists()):
        return

    report.check(agent.stat().st_size > 5_000_000, "the agent is big enough to carry its runtime")
    report.check(setup.stat().st_size > agent.stat().st_size, "the installer contains the agent payload")

    print("\nBundled runtime")
    result = run([str(agent), "--selftest"])
    ok = result.returncode == 0 and "selftest ok" in (result.stdout or "")
    report.check(ok, "the frozen agent starts without Python installed", (result.stderr or "")[-300:])
    report.check("pyautogui" in (result.stdout or ""), "the automation runtime is inside the bundle")

    print("\nInstaller payload")
    check_result = run([str(setup), "/CHECK"])
    report.check(
        check_result.returncode == 0 and "payload ok" in (check_result.stdout or ""),
        "the installer can read its bundled agent",
        (check_result.stderr or "")[-300:],
    )


def verify_manifest(
    report: Report,
    channel: str,
    manifest_path: Path,
    artifacts_dir: Path,
    *,
    expected_publisher: str | None = None,
) -> dict | None:
    """Checks one channel's manifest against the file it names.

    `artifacts_dir` is where the pair should be: `public/downloads` for a
    published build, `desktop/out/release` for an unpublished one. The path is
    injected so the tests can point it at a temporary directory.
    """
    print(f"\nManifest ({channel})")
    if not manifest_path.exists():
        report.check(
            False,
            f"{manifest_path.name} exists",
            "nothing is published for this channel",
        )
        return None

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        report.check(False, "the manifest is valid JSON", str(error))
        return None

    for field in ("product", "version", "file", "os", "architecture", "sha256", "bytes", "releasedAt"):
        report.check(bool(manifest.get(field)), f"manifest has {field}")

    report.check(
        manifest.get("channel") == channel,
        f"the manifest declares channel {channel!r}",
        f"manifest says {manifest.get('channel')!r} — a build of another channel cannot be verified as this one",
    )
    report.check(
        manifest.get("file") == installer_name(channel),
        "the manifest names this channel's installer",
        f"{manifest.get('file')!r} instead of {installer_name(channel)!r}",
    )

    name = Path(str(manifest.get("file", ""))).name
    report.check(
        name == manifest.get("file") and name not in ("", ".", ".."),
        "the file name is a plain file name",
    )

    local = artifacts_dir / name
    url = None
    if manifest.get("url"):
        try:
            url = validate_download_url(str(manifest["url"]))
        except ConfigError as error:
            report.check(False, "the download URL is a real https URL", str(error))
    report.check(
        local.exists() or bool(url),
        "the installer named by the manifest is available",
        f"neither {local} nor an external url",
    )

    if local.exists():
        report.check(
            local.stat().st_size == manifest.get("bytes"),
            "manifest size matches the file",
            f"{local.stat().st_size} != {manifest.get('bytes')}",
        )
        report.check(
            sha256_of(local) == manifest.get("sha256"),
            "manifest SHA-256 matches the file",
        )

        checksum_file = artifacts_dir / f"{name}.sha256"
        if checksum_file.exists():
            expected = checksum_file.read_text(encoding="ascii").split()[0]
            report.check(
                expected == manifest.get("sha256"),
                "the .sha256 file matches the manifest",
            )
        else:
            report.check(False, "a .sha256 file is published next to the installer")

        actual = describe_signature(local)
        declared = manifest.get("signature") or {}
        declared_status = declared.get("status") or (
            "unsigned" if not manifest.get("signed") else "verified"
        )

        if actual["status"] in ("unsigned", "verified", "self-signed"):
            report.check(
                declared_status == actual["status"],
                "the manifest matches the file's signature",
                f"manifest says {declared_status}, the file is {actual['status']}",
            )
            report.check(
                (manifest.get("signed") is True) == (actual["status"] != "unsigned"),
                "the signed flag matches the signature",
            )
            if actual["status"] == "verified" and expected_publisher:
                report.check(
                    publisher_matches(actual.get("subject"), expected_publisher),
                    "the certificate is the expected publisher",
                    f"expected {expected_publisher!r}, got {actual.get('subject')!r}",
                )
        else:
            report.note(
                "Windows did not report an Authenticode state here; the manifest's "
                "signature claims were checked internally only"
            )

    if channel == PRODUCTION:
        declared = (manifest.get("signature") or {}).get("status")
        report.check(
            declared == "verified",
            "a production manifest carries a trusted signature",
            f"signature status is {declared!r}",
        )
        report.check(
            manifest.get("signed") is True,
            "a production manifest is marked as signed",
        )
        if expected_publisher:
            report.check(
                publisher_matches((manifest.get("signature") or {}).get("subject"), expected_publisher),
                "the manifest's signer is the expected publisher",
                f"expected {expected_publisher!r}",
            )
        report.check(
            not (manifest.get("signature") or {}).get("windowsStatus") == "HashMismatch",
            "the signature is not a hash mismatch",
        )
    else:
        report.check(
            manifest.get("channel") == DEVELOPMENT,
            "a development manifest is not presented as a release",
        )

    return manifest


def verify_install(report: Report, channel: str) -> None:
    print("\nInstall / uninstall cycle")
    setup = DIST / "ParadoxSetup.exe"
    if not setup.exists():
        report.check(False, "the installer exists for the install test")
        return
    if os.name != "nt":
        report.note("not running on Windows: skipping the install cycle")
        return

    target = Path(tempfile.gettempdir()) / f"paradox-verify-{int(time.time())}"
    start_menu = (
        Path(os.environ.get("APPDATA", ""))
        / "Microsoft"
        / "Windows"
        / "Start Menu"
        / "Programs"
        / "Paradox"
        / "Paradox Desktop Agent.lnk"
    )
    try:
        result = run([str(setup), "/S", f"/D={target}", "/NOLAUNCH", "/NODESKTOPICON"], timeout=300)
        report.check(result.returncode == 0, "the installer exits successfully", (result.stderr or "")[-300:])
        report.check((target / "ParadoxAgent.exe").exists(), "the agent is installed")
        report.check((target / "uninstall.cmd").exists(), "an uninstaller is installed")
        report.check(start_menu.exists(), "a Start Menu shortcut exists")

        try:
            assert winreg is not None
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY) as key:
                location = winreg.QueryValueEx(key, "InstallLocation")[0]
            report.check(
                str(location).lower() == str(target).lower(),
                "the Apps entry points at the install folder",
                str(location),
            )
        except (OSError, AssertionError):
            report.check(False, "the app is registered in Settings → Apps")

        installed_agent = target / "ParadoxAgent.exe"
        if installed_agent.exists():
            selftest = run([str(installed_agent), "--selftest"])
            report.check(
                selftest.returncode == 0,
                "the installed agent runs its self-test",
                (selftest.stderr or "")[-300:],
            )

        uninstaller = target / "uninstall.cmd"
        if uninstaller.exists():
            ps = run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", f"& '{uninstaller}'"],
                timeout=180,
            )
            if ps.returncode != 0:
                print(f"        note: {ps.stderr.strip()[:200]}")

        time.sleep(2)
        report.check(not target.exists(), "the uninstaller removes the install folder")
        report.check(not start_menu.exists(), "the uninstaller removes the shortcut")
        still_there = True
        try:
            assert winreg is not None
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY):
                still_there = True
        except (OSError, AssertionError):
            still_there = False
        report.check(not still_there, "the uninstaller removes the Apps entry")
    finally:
        # A failed check must not leave the machine changed
        shutil.rmtree(target, ignore_errors=True)
        shutil.rmtree(
            Path(os.environ.get("APPDATA", ""))
            / "Microsoft"
            / "Windows"
            / "Start Menu"
            / "Programs"
            / "Paradox",
            ignore_errors=True,
        )
        try:
            assert winreg is not None
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY)
        except (OSError, AssertionError):
            pass


def main() -> int:
    # Windows consoles are not UTF-8 by default and these labels use arrows
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser(description="Verify a Desktop Agent build")
    parser.add_argument(
        "--channel",
        default=os.environ.get("PARADOX_BUILD_CHANNEL")
        or os.environ.get("PARADOX_CHANNEL")
        or DEVELOPMENT,
        help="development (default) or production; 'dev'/'release' are aliases",
    )
    parser.add_argument(
        "--artifacts",
        default=None,
        help="Directory holding the installer + manifest to check "
        "(default: public/downloads, or desktop/out/release for an unpublished build)",
    )
    parser.add_argument(
        "--manifest",
        default=None,
        help="Explicit manifest path (default: the channel's file inside --artifacts)",
    )
    parser.add_argument(
        "--install-test",
        action="store_true",
        help="Perform a real silent install and uninstall in a temporary folder",
    )
    parser.add_argument(
        "--skip-artifacts",
        action="store_true",
        help="Only check the manifest (the executables were built elsewhere)",
    )
    args = parser.parse_args()

    try:
        channel = normalize_channel(args.channel)
    except ConfigError as error:
        print(f"configuration error: {error}", file=sys.stderr)
        return 2

    artifacts = Path(args.artifacts) if args.artifacts else DOWNLOADS
    manifest_path = Path(args.manifest) if args.manifest else artifacts / manifest_name(channel)

    print(f"Paradox Desktop Agent verification · {channel} · {ROOT}")

    report = Report()
    if not args.skip_artifacts:
        verify_artifacts(report, channel)

    expected_publisher = (os.environ.get("PARADOX_SIGN_PUBLISHER") or "").strip() or None
    manifest = verify_manifest(
        report,
        channel,
        manifest_path,
        artifacts,
        expected_publisher=expected_publisher,
    )

    if args.install_test:
        verify_install(report, channel)

    print(f"\n{report.checks - len(report.failures)}/{report.checks} checks passed")
    if report.failures:
        print("failed: " + ", ".join(report.failures))
        return 1
    print(f"verified: {channel} {manifest.get('version') if manifest else 'unknown'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
