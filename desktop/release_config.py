"""
Release configuration for Paradox Desktop Agent.

One place decides what a build is allowed to do, so `package.py`, `verify.py`,
the CI workflow and the tests cannot disagree:

    development  a testable installer: no certificate required, a local or
                 staging server allowed, never an official release.
    production   an official release: HTTPS production server, a real signing
                 certificate, a verified signature from the expected publisher,
                 and publication only when it is explicitly requested.

Nothing here talks to the network, Windows or the filesystem beyond hashing a
file, which is what makes it testable on any platform.

Environment variables (canonical names; the old names remain accepted aliases so
an existing local setup does not break):

    PARADOX_BUILD_CHANNEL     development | production   (alias: PARADOX_CHANNEL)
    PARADOX_API_URL           server the installed agent connects to
                              (legacy alias: PARADOX_API_BASE)
    PARADOX_SIGN_PFX          path to a .pfx code-signing certificate
    PARADOX_SIGN_PASSWORD     password for that .pfx (never logged)
    PARADOX_SIGN_THUMBPRINT   thumbprint of a certificate already in the store
    PARADOX_SIGN_PUBLISHER    expected publisher identity (CN or O), production
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
from pathlib import Path
from urllib.parse import urlsplit

DEVELOPMENT = "development"
PRODUCTION = "production"

CHANNELS = (DEVELOPMENT, PRODUCTION)

# Old spellings keep working: `dev` and `release` appear in existing scripts,
# manifests and documentation.
CHANNEL_ALIASES = {
    "dev": DEVELOPMENT,
    "development": DEVELOPMENT,
    "release": PRODUCTION,
    "production": PRODUCTION,
}

# The filename of what a channel produces. A development build has its own
# installer and its own manifest, so it can never be mistaken for - or overwrite
# - the official pair the download endpoint serves.
INSTALLER_NAMES = {
    DEVELOPMENT: "ParadoxSetup-dev.exe",
    PRODUCTION: "ParadoxSetup.exe",
}

MANIFEST_NAMES = {
    DEVELOPMENT: "desktop-dev.json",
    PRODUCTION: "desktop.json",
}

# Hosts that can never be a production server.
_PLACEHOLDER_HOSTS = {
    "example.com",
    "www.example.com",
    "example.org",
    "example.net",
    "example.edu",
    "paradox.example",
    "app.paradox.example",
}

_RESERVED_SUFFIXES = (
    ".example",
    ".test",
    ".invalid",
    ".localhost",
    ".local",
    ".internal",
)

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$")


class ConfigError(ValueError):
    """A build was asked for with configuration that cannot be trusted."""


def normalize_channel(value: str | None) -> str:
    key = (value or "").strip().lower()
    if key in CHANNEL_ALIASES:
        return CHANNEL_ALIASES[key]
    raise ConfigError(
        f"unknown build channel {value!r}: use 'development' or 'production' "
        "(the older names 'dev' and 'release' are accepted)"
    )


def installer_name(channel: str) -> str:
    return INSTALLER_NAMES[normalize_channel(channel)]


def manifest_name(channel: str) -> str:
    return MANIFEST_NAMES[normalize_channel(channel)]


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_version(version: str, channel: str) -> str:
    channel = normalize_channel(channel)
    if not VERSION_RE.match(version or ""):
        raise ConfigError(
            f"version {version!r} is not valid: use MAJOR.MINOR.PATCH "
            "(for example 1.2.0)"
        )
    if channel == PRODUCTION and version.startswith("0."):
        raise ConfigError(
            f"version {version!r} cannot be published as a production release: "
            "an official release starts at 1.0.0"
        )
    return version


def _is_loopback(host: str) -> bool:
    if host in {"localhost", "localhost.localdomain", "::1"}:
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback


def _is_private(host: str) -> bool:
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
        or address.is_unspecified
    )


def _is_placeholder(host: str) -> bool:
    if host in _PLACEHOLDER_HOSTS:
        return True
    return any(host.endswith(suffix) for suffix in _RESERVED_SUFFIXES)


def validate_api_url(url: str | None, channel: str) -> str:
    """The server the installed agent will talk to, or a clear failure.

    Development accepts a local address (``http://localhost:3000``) because that
    is how the agent is tested against the dev app. Production demands a real
    HTTPS host: a localhost, a reserved domain or an example domain in a release
    is a configuration mistake, never something to ship.
    """
    channel = normalize_channel(channel)
    value = (url or "").strip()
    if not value:
        raise ConfigError(
            "the server URL is empty: set PARADOX_API_URL (or pass --api). "
            + (
                "For production it must be the public HTTPS address of Paradox."
                if channel == PRODUCTION
                else "For a development build, for example http://localhost:3000."
            )
        )

    if " " in value:
        raise ConfigError(f"the server URL {value!r} contains a space")

    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"}:
        raise ConfigError(
            f"the server URL {value!r} must start with http:// or https://"
        )
    if parts.username or parts.password:
        raise ConfigError("the server URL must not contain credentials")
    if parts.query or parts.fragment:
        raise ConfigError("the server URL must not contain a query or a fragment")
    if not parts.hostname:
        raise ConfigError(f"the server URL {value!r} has no host")

    host = parts.hostname.lower()

    if _is_placeholder(host):
        raise ConfigError(
            f"the server URL {value!r} is a placeholder or a reserved domain, "
            "not a real server"
        )

    if channel == PRODUCTION:
        if parts.scheme != "https":
            raise ConfigError(
                "a production build needs an https:// server URL; the agent "
                "would send device tokens over plain http"
            )
        if _is_loopback(host) or _is_private(host):
            raise ConfigError(
                f"a production build cannot point at {host!r}: that is a local "
                "or private address, so nobody outside this machine could connect"
            )
        if "." not in host:
            raise ConfigError(
                f"a production build needs a public hostname, not {host!r}"
            )
    else:
        if parts.scheme == "http" and not (_is_loopback(host) or _is_private(host)):
            raise ConfigError(
                f"a development build can use plain http only for a local "
                f"address; {host!r} needs https://"
            )

    path = parts.path.rstrip("/")
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.scheme}://{host}{port}{path}"


def validate_download_url(url: str | None) -> str | None:
    """An optional external download URL stored in a release manifest.

    Used when the installer is hosted outside this deployment (a GitHub Release,
    for instance). It must be HTTPS and a real host, in any channel, because a
    download link is sent to people either way.
    """
    value = (url or "").strip()
    if not value:
        return None
    parts = urlsplit(value)
    if parts.scheme != "https":
        raise ConfigError(
            f"the download URL {value!r} must be https:// so the installer is "
            "not fetched over plain http"
        )
    host = (parts.hostname or "").lower()
    if not host or _is_placeholder(host) or _is_loopback(host):
        raise ConfigError(
            f"the download URL {value!r} does not point at a real public host"
        )
    return value


def signing_requirements(channel: str, env: dict[str, str | None]) -> dict:
    """What signing has to look like for this channel.

    Returns a description the build prints and enforces. For production, a
    missing certificate or a missing expected publisher is a configuration
    error raised *before* anything is compiled.
    """
    channel = normalize_channel(channel)
    pfx = (env.get("PARADOX_SIGN_PFX") or "").strip()
    thumbprint = (env.get("PARADOX_SIGN_THUMBPRINT") or "").strip()
    password = (env.get("PARADOX_SIGN_PASSWORD") or "").strip()
    publisher = (env.get("PARADOX_SIGN_PUBLISHER") or "").strip()

    if channel == PRODUCTION:
        if not pfx and not thumbprint:
            raise ConfigError(
                "a production release needs a code-signing certificate: set "
                "PARADOX_SIGN_PFX (+ PARADOX_SIGN_PASSWORD) or "
                "PARADOX_SIGN_THUMBPRINT. Development builds do not."
            )
        if not publisher:
            raise ConfigError(
                "a production release needs the expected publisher identity: "
                "set PARADOX_SIGN_PUBLISHER to the certificate subject "
                "(for example 'CN=Paradox Technologies SL, O=Paradox')"
            )
        if pfx and not password:
            # A passwordless PFX is legal, but silence about it is how a build
            # ends up signed with the wrong key; ask for the password explicitly.
            raise ConfigError(
                "PARADOX_SIGN_PFX is set but PARADOX_SIGN_PASSWORD is not. Set "
                "the password (even an empty value must be explicit) or use "
                "PARADOX_SIGN_THUMBPRINT for a certificate already in the store."
            )

    return {
        "required": channel == PRODUCTION,
        "pfx": bool(pfx),
        "thumbprint": bool(thumbprint),
        "publisher": publisher or None,
        # Development may sign with a throwaway certificate only when asked.
        "allow_test_certificate": channel == DEVELOPMENT,
    }


def normalize_identity(value: str) -> str:
    return re.sub(r"\s+", "", (value or "").lower())


def publisher_matches(subject: str | None, expected: str | None) -> bool:
    """Whether a certificate subject is the publisher production expects.

    Tolerant about how the subject is written (`CN=Paradox, O=Paradox` vs
    `Paradox`), strict about it being the same identity: the expected value has
    to appear in the subject, and it cannot be an empty or generic string.
    """
    if not expected or not expected.strip():
        return False
    if not subject or not subject.strip():
        return False

    normalized_subject = normalize_identity(subject)
    normalized_expected = normalize_identity(expected)

    if len(normalized_expected) < 3:
        return False

    # A full subject was configured ("CN=..., O=..."): it has to appear as such.
    if "=" in expected:
        return normalized_expected in normalized_subject

    # A bare identity is compared against each RDN value, and it has to match
    # from the start: "Paradox" must not match "NotParadox Ltd".
    values = []
    for part in subject.split(","):
        name, _, value = part.partition("=")
        if name.strip().upper() in {"CN", "O", "OU"}:
            values.append(normalize_identity(value))

    return any(value.startswith(normalized_expected) for value in values)


def describe_plan(
    channel: str,
    version: str,
    api_url: str,
    *,
    will_publish: bool,
    publisher: str | None = None,
) -> list[str]:
    """The lines the build prints so the operator sees what it is about to do."""
    channel = normalize_channel(channel)
    lines = [
        f"channel      {channel}"
        + (" (development build - not an official release)" if channel == DEVELOPMENT else ""),
        f"version      {version}",
        f"server       {api_url}",
        f"installer    {installer_name(channel)}",
        f"manifest     {manifest_name(channel)}",
    ]
    if channel == PRODUCTION:
        lines.append(f"publisher    {publisher or '(missing)'}")
        lines.append(
            "publication  "
            + ("authorized for this run" if will_publish else "not requested - artifacts only")
        )
    else:
        lines.append(
            "publication  local download"
            if will_publish
            else "publication  skipped"
        )
    return lines
