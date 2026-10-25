"""
Builds the Paradox Desktop Agent and its Windows installer.

Two channels, one pipeline:

    python desktop/package.py --channel development --version 1.2.0 \
        --api http://localhost:3000

        A testable build. No certificate and no public domain are required. It
        is written as ParadoxSetup-dev.exe + desktop-dev.json, which the official
        download endpoint never serves as the current release.

    python desktop/package.py --channel production --version 1.2.0 \
        --api https://app.tudominio.com --publish

        An official release. It refuses to run without a signing certificate, an
        expected publisher, an HTTPS production URL and a valid version; it
        signs, verifies the signature, then offers the artifact for publication.
        Without --publish it validates and stages the artifacts but writes
        nothing into `public/downloads`.

Steps, all before anything is published:

1. configuration is validated (channel, version, server URL, signing);
2. python environment in `desktop/.venv`;
3. `pc-agent/agent.py` frozen into `ParadoxAgent.exe`;
4. that executable self-tested (`--selftest`);
5. `desktop/installer/install.py` frozen into the installer with the agent
   inside it as a payload;
6. the setup executable self-tested (`/CHECK`);
7. signing when configured (mandatory for production), then the signature is
   read back and checked, including the publisher identity;
8. SHA-256 and size taken from the final signed file;
9. the manifest is written next to the artifact in `desktop/out/release/`
   (and, for a development build or an explicitly authorized production
   release, copied into `public/downloads/`);
10. the published pair is read back and compared.

Exit codes: 0 success, 1 build failure, 2 invalid configuration.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from release_config import (
    ConfigError,
    DEVELOPMENT,
    PRODUCTION,
    describe_plan,
    installer_name,
    manifest_name,
    normalize_channel,
    publisher_matches,
    sha256_of,
    signing_requirements,
    validate_api_url,
    validate_download_url,
    validate_version,
)

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "desktop"
AGENT_SOURCE = ROOT / "pc-agent" / "agent.py"
INSTALLER_SOURCE = DESKTOP / "installer" / "install.py"
VENV = DESKTOP / ".venv"
DIST = DESKTOP / "dist"
WORK = DESKTOP / "build"
OUT = DESKTOP / "out"
# Every build, published or not, is staged here in one predictable place: CI
# uploads this folder, and publishing copies from it.
ARTIFACTS = OUT / "release"
DOWNLOADS = ROOT / "public" / "downloads"

AGENT_EXE = DIST / "ParadoxAgent.exe"
SETUP_EXE = DIST / "ParadoxSetup.exe"


class BuildError(RuntimeError):
    pass


def say(message: str = "") -> None:
    print(message, flush=True)


def step(title: str) -> None:
    say(f"\n==> {title}")


def run(command: list[str], **kwargs) -> subprocess.CompletedProcess:
    result = subprocess.run(command, cwd=str(ROOT), text=True, **kwargs)
    if result.returncode != 0:
        raise BuildError(
            f"command failed ({result.returncode}): {' '.join(command)}\n"
            f"{(result.stdout or '')[-2000:]}\n{(result.stderr or '')[-2000:]}"
        )
    return result


def python_exe() -> Path:
    candidate = VENV / "Scripts" / "python.exe"
    if candidate.exists():
        return candidate
    candidate = VENV / "bin" / "python"
    if candidate.exists():
        return candidate
    raise BuildError("desktop/.venv is missing — run this script again to create it")


def source_version() -> str:
    text = AGENT_SOURCE.read_text(encoding="utf-8")
    match = re.search(r'^VERSION = "([^"]+)"', text, re.MULTILINE)
    return match.group(1) if match else "0.0.0"


# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

def ensure_environment() -> None:
    step("Python environment")
    if not VENV.exists():
        say("    creating desktop/.venv")
        subprocess.run(
            [sys.executable, "-m", "venv", str(VENV)],
            check=True,
        )

    python = python_exe()
    run([str(python), "-m", "pip", "install", "--upgrade", "pip", "-q"])
    run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "-q",
            "pyautogui",
            "pillow",
            # The local browser engine drives the person's installed Chrome or
            # Edge over CDP. No browser is downloaded: only the client library
            # ships, and it is optional at runtime.
            "playwright",
            "pyinstaller",
        ]
    )
    version = run([str(python), "-m", "PyInstaller", "--version"], capture_output=True).stdout
    say(f"    PyInstaller {version.strip()}")


# ---------------------------------------------------------------------------
# Freezing
# ---------------------------------------------------------------------------

def freeze_agent() -> Path:
    step("Freezing the agent")
    OUT.mkdir(parents=True, exist_ok=True)
    run(
        [
            str(python_exe()),
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--onefile",
            "--name",
            "ParadoxAgent",
            # Playwright ships a Node driver that PyInstaller cannot see
            "--collect-all",
            "playwright",
            "--hidden-import",
            "browser_engine",
            "--distpath",
            str(DIST),
            "--workpath",
            str(WORK / "agent"),
            "--specpath",
            str(WORK / "agent"),
            str(AGENT_SOURCE),
        ]
    )
    if not AGENT_EXE.exists():
        raise BuildError("ParadoxAgent.exe was not produced")
    say(f"    {AGENT_EXE}  ({AGENT_EXE.stat().st_size / 1024 / 1024:.1f} MB)")
    return AGENT_EXE


def selftest_agent() -> None:
    step("Self-testing the frozen agent (no server needed)")
    result = subprocess.run(
        [str(AGENT_EXE), "--selftest"],
        cwd=str(DIST),
        text=True,
        capture_output=True,
    )
    say("    " + (result.stdout or "").strip().replace("\n", "\n    "))
    if result.returncode != 0:
        raise BuildError(
            "the bundled agent could not start or is missing its automation runtime:\n"
            + (result.stderr or "")
        )


def freeze_installer(version: str, api_base: str, channel: str) -> Path:
    step("Freezing the installer")
    build_info = {
        "version": version,
        "apiBase": api_base,
        "channel": channel,
        "development": channel == DEVELOPMENT,
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    info_path = DESKTOP / "installer" / "build_info.json"
    info_path.write_text(json.dumps(build_info, indent=2), encoding="utf-8")

    run(
        [
            str(python_exe()),
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--onefile",
            "--name",
            "ParadoxSetup",
            "--distpath",
            str(DIST),
            "--workpath",
            str(WORK / "installer"),
            "--specpath",
            str(WORK / "installer"),
            "--add-data",
            f"{AGENT_EXE}{os.pathsep}payload",
            "--add-data",
            f"{info_path}{os.pathsep}.",
            str(INSTALLER_SOURCE),
        ]
    )
    if not SETUP_EXE.exists():
        raise BuildError("ParadoxSetup.exe was not produced")
    say(f"    {SETUP_EXE}  ({SETUP_EXE.stat().st_size / 1024 / 1024:.1f} MB)")
    return SETUP_EXE


def selftest_installer() -> None:
    step("Self-testing the installer payload")
    result = subprocess.run(
        [str(SETUP_EXE), "/CHECK"],
        cwd=str(DIST),
        text=True,
        capture_output=True,
    )
    say("    " + (result.stdout or "").strip().replace("\n", "\n    "))
    if result.returncode != 0:
        raise BuildError("the installer cannot read its own payload:\n" + (result.stderr or ""))


# ---------------------------------------------------------------------------
# Signing
# ---------------------------------------------------------------------------

UNSIGNED = {"status": "unsigned"}


def ps(script: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ],
            capture_output=True,
            text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError as error:
        # No PowerShell (a Linux build machine): reported as unsigned, never as
        # a signature that was not verified.
        return subprocess.CompletedProcess([], 1, "", str(error))


def ps_ok(script: str, what: str) -> str:
    result = ps(script)
    if result.returncode != 0:
        raise BuildError(f"{what} failed:\n{(result.stderr or result.stdout or '').strip()}")
    return (result.stdout or "").strip()


def describe_signature(path: Path) -> dict:
    """What Authenticode says about a file, without trusting it.

    `verified` means Windows trusts the chain and the digest matches;
    `self-signed` means there is a real signature whose certificate is not
    trusted (a test build); `unsigned` means there is no signature. A digest
    mismatch is never reported as signed.
    """
    script = (
        "$s = Get-AuthenticodeSignature -FilePath '{p}';"
        "[pscustomobject]@{{"
        "  Status = $s.Status.ToString();"
        "  Subject = if ($s.SignerCertificate) {{ $s.SignerCertificate.Subject }} else {{ '' }};"
        "  Thumbprint = if ($s.SignerCertificate) {{ $s.SignerCertificate.Thumbprint }} else {{ '' }};"
        "  SelfIssued = if ($s.SignerCertificate) {{ $s.SignerCertificate.Subject -eq $s.SignerCertificate.Issuer }} else {{ $false }};"
        "  Timestamped = [bool]$s.TimeStamperCertificate;"
        "}} | ConvertTo-Json -Compress"
    ).format(p=str(path).replace("'", "''"))

    try:
        raw = ps_ok(script, "reading the Authenticode signature")
        info = json.loads(raw)
    except (BuildError, json.JSONDecodeError):
        # PowerShell missing or unreadable: treat as unsigned rather than claim a signature
        return dict(UNSIGNED)

    status = str(info.get("Status") or "")
    subject = str(info.get("Subject") or "")
    thumbprint = str(info.get("Thumbprint") or "")

    if status == "HashMismatch":
        raise BuildError("the signature does not match the file contents (HashMismatch)")
    # Windows reports states such as UnknownError or NotSupportedFileFormat for
    # files that carry no signature at all. Only a real signer certificate means
    # the artifact is signed: claiming otherwise would let an unsigned file be
    # published as signed.
    if status in ("NotSigned", "") or not (subject or thumbprint):
        return dict(UNSIGNED)

    trusted = status == "Valid"
    return {
        "status": "verified" if trusted else "self-signed",
        "subject": subject,
        "thumbprint": thumbprint,
        "timestamped": bool(info.get("Timestamped")),
        "windowsStatus": status,
    }


def import_pfx(pfx: str, password: str | None) -> str:
    """Imports the certificate into the current user's store for this build."""
    escaped = (password or "").replace("'", "''")
    if escaped:
        secret = f"ConvertTo-SecureString -String '{escaped}' -AsPlainText -Force"
    else:
        # An explicitly empty password is still a password; PowerShell refuses
        # an empty literal, so the secure string is built empty.
        secret = "New-Object System.Security.SecureString"
    script = (
        f"$sec = {secret};"
        "(Import-PfxCertificate -FilePath '{pfx}' -CertStoreLocation Cert:\\CurrentUser\\My "
        "-Password $sec).Thumbprint"
    ).format(pfx=pfx.replace("'", "''"))
    thumbprint = ps_ok(script, "importing the signing certificate")
    if not thumbprint:
        raise BuildError("the certificate file did not yield a thumbprint")
    return thumbprint


def create_test_certificate() -> str:
    """A throwaway code-signing certificate for verifying the signing path.

    It lives in the current user's store, expires in a week and is removed by
    the build after signing. Windows will not trust it, so builds signed this
    way are reported as `self-signed`, never as verified releases.
    """
    script = (
        "$cert = New-SelfSignedCertificate -Type CodeSigningCert "
        "-Subject 'CN=Paradox Desktop Agent (Development), O=Paradox' "
        "-CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddDays(7);"
        "$cert.Thumbprint"
    )
    return ps_ok(script, "creating the test certificate")


def remove_certificate(thumbprint: str) -> None:
    if not thumbprint:
        return
    ps(f"Remove-Item -Path 'Cert:\\CurrentUser\\My\\{thumbprint}' -Force")


def sign_installer(installer: Path, self_sign: bool, channel: str) -> dict:
    """Signs the installer when a certificate is available.

    Order of choice: an explicit PFX (`PARADOX_SIGN_PFX`), a certificate already
    in the store (`PARADOX_SIGN_THUMBPRINT`), or — only in development, only
    when asked — a throwaway test certificate. Timestamping needs the network; a
    failed timestamp keeps a signature that is not timestamped.
    """
    pfx = os.environ.get("PARADOX_SIGN_PFX")
    password = os.environ.get("PARADOX_SIGN_PASSWORD")
    thumbprint = os.environ.get("PARADOX_SIGN_THUMBPRINT")

    imported = False
    if pfx:
        step("Signing the installer (PFX)")
        thumbprint = import_pfx(pfx, password)
        imported = True
    elif not thumbprint and self_sign:
        if channel == PRODUCTION:
            raise BuildError(
                "a production release cannot be signed with a throwaway test "
                "certificate. Provide a CA-issued code-signing certificate."
            )
        step("Signing the installer (development test certificate)")
        thumbprint = create_test_certificate()
        imported = True

    if not thumbprint:
        say("    no signing certificate configured (PARADOX_SIGN_PFX / PARADOX_SIGN_THUMBPRINT)")
        return dict(describe_signature(installer))

    try:
        template = (
            "$cert = Get-Item 'Cert:\\CurrentUser\\My\\{thumb}';"
            "$sig = Set-AuthenticodeSignature -FilePath '{file}' -Certificate $cert "
            "-HashAlgorithm SHA256{extra};"
            "if ($sig.Status -eq 'HashMismatch') {{ throw 'HashMismatch' }};"
            "$sig.Status.ToString()"
        )
        with_timestamp = template.format(
            thumb=thumbprint,
            file=str(installer).replace("'", "''"),
            extra=" -TimestampServer 'http://timestamp.digicert.com'",
        )
        try:
            status = ps_ok(with_timestamp, "signing the installer")
        except BuildError:
            # No network for the timestamp authority: keep the signature
            say("    timestamp server unreachable — signing without a timestamp")
            status = ps_ok(
                template.format(
                    thumb=thumbprint,
                    file=str(installer).replace("'", "''"),
                    extra="",
                ),
                "signing the installer",
            )
        say(f"    signature written (Windows reports: {status})")
    finally:
        if imported:
            # The signature embeds the certificate; the private key does not stay
            remove_certificate(thumbprint)

    signature = describe_signature(installer)
    if signature["status"] == "verified":
        say("    signature verified (trusted chain)")
    elif signature["status"] == "self-signed":
        say("    signed with a certificate Windows does not trust — development build only")
    else:
        raise BuildError("the installer was signed but no signature could be read back")
    return signature


# ---------------------------------------------------------------------------
# Staging and publishing
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def stage(
    version: str,
    channel: str,
    signature: dict,
    notes: str | None,
    download_url: str | None,
) -> dict:
    """Writes the artifact, its checksum and its manifest into desktop/out/release.

    The hash is taken from the *signed* file that will actually be distributed,
    and the manifest is read back and compared before this returns.
    """
    step("Staging the release artifacts")
    ARTIFACTS.mkdir(parents=True, exist_ok=True)

    name = installer_name(channel)
    artifact = ARTIFACTS / name
    shutil.copy2(SETUP_EXE, artifact)

    digest = sha256_of(artifact)
    size = artifact.stat().st_size

    manifest = {
        "product": "Paradox Desktop Agent",
        "version": version,
        "file": name,
        "os": "Windows 10/11",
        "architecture": "x64",
        "sha256": digest,
        "bytes": size,
        "releasedAt": now_iso(),
        "minimumAppVersion": version,
        "channel": channel,
        "signed": signature.get("status") != "unsigned",
        "signature": signature,
    }
    if download_url:
        manifest["url"] = download_url
    if notes:
        manifest["notes"] = notes

    manifest_path = ARTIFACTS / manifest_name(channel)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (ARTIFACTS / f"{name}.sha256").write_text(
        f"{digest}  {name}\n", encoding="ascii"
    )

    written = json.loads(manifest_path.read_text(encoding="utf-8"))
    if written.get("sha256") != sha256_of(artifact):
        raise BuildError("the staged file does not match the manifest checksum")
    if written.get("bytes") != artifact.stat().st_size:
        raise BuildError("the manifest size does not match the staged file")

    say(f"    {artifact}  ({size / 1024 / 1024:.1f} MB)")
    say(f"    {manifest_path}")
    say(f"    sha256 {digest}")
    return manifest


def publish(manifest: dict) -> None:
    """Copies the verified pair into public/downloads and re-checks it there.

    Development builds write their own pair (`ParadoxSetup-dev.exe` +
    `desktop-dev.json`); a production release writes the official pair. Neither
    can overwrite the other, and the file is hashed again after the copy.
    """
    step("Publishing to public/downloads")
    DOWNLOADS.mkdir(parents=True, exist_ok=True)

    channel = manifest["channel"]
    name = manifest["file"]
    source_dir = ARTIFACTS

    shutil.copy2(source_dir / name, DOWNLOADS / name)
    shutil.copy2(
        source_dir / manifest_name(channel), DOWNLOADS / manifest_name(channel)
    )
    shutil.copy2(source_dir / f"{name}.sha256", DOWNLOADS / f"{name}.sha256")

    published = DOWNLOADS / name
    actual = sha256_of(published)
    if actual != manifest["sha256"]:
        raise BuildError(
            "the published file does not match the manifest checksum "
            f"({actual} != {manifest['sha256']})"
        )
    if published.stat().st_size != manifest["bytes"]:
        raise BuildError("the manifest size does not match the published file")

    say(f"    {published}  ({manifest['bytes'] / 1024 / 1024:.1f} MB)")
    say(f"    {DOWNLOADS / manifest_name(channel)}")
    say(
        f"    channel {channel} · signature "
        f"{manifest['signature'].get('status', 'unsigned')}"
    )


def remove_previous_outputs(channel: str) -> None:
    """A rebuild never leaves a stale manifest pointing at a file that is gone."""
    for directory in (ARTIFACTS, DOWNLOADS):
        for path in (
            directory / installer_name(channel),
            directory / manifest_name(channel),
            directory / f"{installer_name(channel)}.sha256",
        ):
            try:
                path.unlink()
            except FileNotFoundError:
                pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build_plan(args) -> tuple[str, str, str, dict, str | None]:
    """Validates everything a build needs before compiling anything."""
    channel = normalize_channel(args.channel)
    version = validate_version(args.version or source_version(), channel)

    raw_api = (
        args.api
        or os.environ.get("PARADOX_API_URL")
        or os.environ.get("PARADOX_API_BASE")
        or ("http://localhost:3000" if channel == DEVELOPMENT else "")
    )
    api_base = validate_api_url(raw_api, channel)
    download_url = validate_download_url(args.download_url)

    if channel == PRODUCTION and args.self_sign:
        raise ConfigError(
            "--self-sign produces a test certificate, which can never sign a "
            "production release"
        )

    signing = signing_requirements(channel, os.environ)

    # A configured file that is not there is a configuration error, not a
    # signing failure twenty minutes into the build.
    if channel == PRODUCTION:
        pfx = (os.environ.get("PARADOX_SIGN_PFX") or "").strip()
        if pfx and not Path(pfx).exists():
            raise ConfigError(
                f"the signing certificate {pfx!r} does not exist. Point "
                "PARADOX_SIGN_PFX at the .pfx, or use PARADOX_SIGN_THUMBPRINT "
                "for a certificate already in the store."
            )

    return channel, version, api_base, signing, download_url


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build and stage the Paradox Desktop Agent"
    )
    parser.add_argument(
        "--version",
        default=None,
        help="Build version, MAJOR.MINOR.PATCH (default: pc-agent VERSION)",
    )
    parser.add_argument(
        "--channel",
        default=os.environ.get("PARADOX_BUILD_CHANNEL")
        or os.environ.get("PARADOX_CHANNEL")
        or DEVELOPMENT,
        help="development (default) or production; 'dev'/'release' are aliases",
    )
    parser.add_argument(
        "--api",
        default=None,
        help="Server the installed agent connects to (PARADOX_API_URL)",
    )
    parser.add_argument(
        "--download-url",
        default=None,
        help="Optional https URL where the installer is hosted (release manifest)",
    )
    parser.add_argument("--notes", default=None, help="Release notes for the manifest")
    parser.add_argument(
        "--skip-agent",
        action="store_true",
        help="Reuse an existing agent binary (fast: rehearse the installer steps)",
    )
    parser.add_argument(
        "--no-publish",
        action="store_true",
        help="Stage into desktop/out/release only; do not copy into public/downloads",
    )
    parser.add_argument(
        "--publish",
        action="store_true",
        help="Production only: authorize copying the verified pair into public/downloads",
    )
    parser.add_argument(
        "--self-sign",
        action="store_true",
        help="Development only: sign with a throwaway test certificate",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate the configuration and exit without building anything",
    )
    args = parser.parse_args()

    try:
        channel, version, api_base, signing, download_url = build_plan(args)
    except ConfigError as error:
        print(f"\nconfiguration error: {error}", file=sys.stderr)
        return 2

    say("\nParadox Desktop Agent")
    for line in describe_plan(
        channel,
        version,
        api_base,
        will_publish=(not args.no_publish)
        and (channel == DEVELOPMENT or args.publish),
        publisher=signing.get("publisher"),
    ):
        say(f"  {line}")

    # CI validates in its own step so a missing certificate or URL fails in
    # seconds, before anything is compiled.
    if args.check:
        say("\nConfiguration valid. Nothing was built.")
        return 0

    # Publication is an explicit act. A development build updates its own
    # download pair (so it can be tried locally); a production release needs
    # --publish, and even then only after every check below passed.
    will_publish = not args.no_publish and (
        channel == DEVELOPMENT or args.publish
    )

    try:
        if args.skip_agent:
            step("Reusing the existing agent binary")
            if not AGENT_EXE.exists():
                raise BuildError("desktop/dist/ParadoxAgent.exe does not exist")
        else:
            ensure_environment()
            freeze_agent()
            selftest_agent()

        remove_previous_outputs(channel)
        freeze_installer(version, api_base, channel)
        selftest_installer()

        signature = sign_installer(SETUP_EXE, self_sign=args.self_sign, channel=channel)

        if channel == PRODUCTION:
            if signature.get("status") != "verified":
                raise BuildError(
                    "a production release needs a signature Windows trusts, and "
                    f"this one is '{signature.get('status')}'. Check the "
                    "certificate and PARADOX_SIGN_PUBLISHER."
                )
            expected = signing.get("publisher")
            if not publisher_matches(signature.get("subject"), expected):
                raise BuildError(
                    "the signed certificate is not the expected publisher: "
                    f"expected {expected!r}, the signature subject is "
                    f"{signature.get('subject')!r}. Nothing was published."
                )
            say(f"    publisher verified: {signature.get('subject')}")

        manifest = stage(version, channel, signature, args.notes, download_url)
        if will_publish:
            publish(manifest)
        else:
            say("\nNot published. Artifacts are in desktop/out/release.")
            if channel == PRODUCTION:
                say("Re-run with --publish once you have authorized this release.")
    except BuildError as error:
        print(f"\nbuild failed: {error}", file=sys.stderr)
        return 1

    say("\nDone.")
    if will_publish:
        say(
            "/download/desktop serves this build when the deployment reads "
            f"{manifest_name(channel)}."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
