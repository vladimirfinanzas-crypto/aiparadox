"""
Paradox Desktop Agent — Windows installer.

Frozen into `ParadoxSetup.exe` by `desktop/package.py`. Everything it needs is
inside the executable: the agent binary travels as a payload, so the person
installing never has to provide Python, pip or Playwright.

What it does, in order:

1. copies `ParadoxAgent.exe` into the target directory (per user, by default
   `%LOCALAPPDATA%\\Paradox\\Desktop Agent`);
2. creates the Start Menu shortcut (and a desktop one when asked);
3. registers the app in Settings → Apps with a working uninstaller;
4. optionally starts the agent, which then shows the 8-character link code.

It requests no administrator rights, opens no ports and stores no secret: the
device token is obtained through the browser approval flow, never shipped here.

Usage (normally through the setup executable):

    ParadoxSetup.exe                 interactive install
    ParadoxSetup.exe /S              silent install (no prompts)
    ParadoxSetup.exe /S /D=C:\\Apps\\Paradox /NOAUTOSTART /LAUNCH
    ParadoxSetup.exe /UNINSTALL      same as running the uninstaller
    ParadoxSetup.exe /CHECK          verify the payload and exit (0 = ok)
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import winreg
from pathlib import Path

APP_NAME = "Paradox Desktop Agent"
APP_ID = "ParadoxDesktopAgent"
PUBLISHER = "Paradox"
AGENT_EXE = "ParadoxAgent.exe"
UNINSTALL_KEY = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{APP_ID}"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"

# Baked in by desktop/package.py next to this file; a missing file means the
# build was made without a target server, which is an install error, not a
# silent guess.
BUILD_INFO: dict = {"version": "0.0.0", "apiBase": "", "channel": "dev"}


def resource_dir() -> Path:
    """Where PyInstaller unpacks the bundle (or the source tree in dev)."""
    return Path(getattr(sys, "_MEIPASS", Path(__file__).parent))


def load_build_info() -> dict:
    path = resource_dir() / "build_info.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return BUILD_INFO
    if not isinstance(data, dict):
        return BUILD_INFO
    return {**BUILD_INFO, **data}


def payload_path() -> Path:
    return resource_dir() / "payload" / AGENT_EXE


def default_target() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "Paradox" / "Desktop Agent"


# ---------------------------------------------------------------------------
# Console
# ---------------------------------------------------------------------------

def say(message: str = "") -> None:
    print(message, flush=True)


def fail(message: str, code: int = 1) -> int:
    print(f"error: {message}", file=sys.stderr, flush=True)
    return code


def parse_args(argv: list[str]) -> dict:
    """Parses the DOS-style switches an installer is called with."""
    options = {
        "silent": False,
        "target": None,
        "autostart": False,
        "desktop_icon": True,
        "launch": None,
        "uninstall": False,
        "check": False,
        "help": False,
    }

    for raw in argv:
        arg = raw.strip().strip('"')
        upper = arg.upper()
        if upper in ("/S", "/SILENT", "/QUIET"):
            options["silent"] = True
        elif upper in ("/UNINSTALL", "--UNINSTALL"):
            options["uninstall"] = True
        elif upper in ("/CHECK", "--CHECK"):
            options["check"] = True
        elif upper in ("/AUTOSTART",):
            options["autostart"] = True
        elif upper in ("/NOAUTOSTART",):
            options["autostart"] = False
        elif upper in ("/NODESKTOPICON",):
            options["desktop_icon"] = False
        elif upper in ("/LAUNCH",):
            options["launch"] = True
        elif upper in ("/NOLAUNCH",):
            options["launch"] = False
        elif upper in ("/?", "/H", "/HELP", "-H", "--HELP"):
            options["help"] = True
        elif upper.startswith("/D="):
            options["target"] = Path(arg[3:].strip().strip('"'))
        elif arg.startswith("--target="):
            options["target"] = Path(arg.split("=", 1)[1].strip().strip('"'))

    return options


def usage() -> None:
    say(
        "\n".join(
            [
                f"{APP_NAME} installer {load_build_info().get('version', '')}",
                "",
                "  ParadoxSetup.exe                  install (asks nothing it can decide)",
                "  ParadoxSetup.exe /S               silent install",
                "  ParadoxSetup.exe /D=<dir>         install to <dir>",
                "  ParadoxSetup.exe /AUTOSTART       start the agent when you sign in",
                "  ParadoxSetup.exe /NODESKTOPICON   skip the desktop shortcut",
                "  ParadoxSetup.exe /LAUNCH          start the agent after install",
                "  ParadoxSetup.exe /UNINSTALL       uninstall",
                "  ParadoxSetup.exe /CHECK           verify the bundled payload",
            ]
        )
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def read_registry(key: int, sub: str, name: str) -> str | None:
    try:
        with winreg.OpenKey(key, sub) as handle:
            value, _ = winreg.QueryValueEx(handle, name)
            return str(value)
    except OSError:
        return None


def installed_dir() -> Path | None:
    value = read_registry(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY, "InstallLocation")
    if not value:
        return None
    return Path(value)


def is_process_running(name: str) -> bool:
    result = subprocess.run(
        ["tasklist", "/FI", f"IMAGENAME eq {name}", "/NH"],
        capture_output=True,
        text=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return name.lower() in (result.stdout or "").lower()


def stop_running_agent() -> None:
    if not is_process_running(AGENT_EXE):
        return
    say("    stopping the running agent so its files can be replaced…")
    subprocess.run(
        ["taskkill", "/IM", AGENT_EXE, "/T"],
        capture_output=True,
        text=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def run_powershell(script: str) -> subprocess.CompletedProcess:
    """Runs a PowerShell snippet hidden, without touching the execution policy."""
    return subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-Command",
            script,
        ],
        capture_output=True,
        text=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def create_shortcut(link: Path, target: Path, arguments: str, workdir: Path) -> None:
    link.parent.mkdir(parents=True, exist_ok=True)
    script = (
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{link}');"
        "$s.TargetPath='{target}';"
        "$s.Arguments='{args}';"
        "$s.WorkingDirectory='{work}';"
        "$s.IconLocation='{target},0';"
        "$s.Description='Paradox Desktop Agent';"
        "$s.Save()"
    ).format(link=link, target=target, args=arguments, work=workdir)
    result = run_powershell(script)
    if result.returncode != 0:
        raise RuntimeError(f"could not create {link.name}: {result.stderr.strip()}")


def start_menu_dir() -> Path:
    appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Paradox"


def desktop_dir() -> Path:
    """The real Desktop folder, honouring OneDrive redirection."""
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
        ) as handle:
            raw, _ = winreg.QueryValueEx(handle, "Desktop")
            expanded = os.path.expandvars(str(raw))
            if expanded and Path(expanded).is_dir():
                return Path(expanded)
    except OSError:
        pass
    return Path.home() / "Desktop"


def uninstall_script() -> str:
    """The uninstaller the Settings app runs.

    It removes the shortcuts, the autostart entry, the Apps entry, the install
    directory and the local device token. The script lives in the install folder
    it deletes, so the cmd wrapper always runs a copy from %TEMP%.
    """
    run_path = "HKCU:" + "\\" + RUN_KEY
    uninstall_path = "HKCU:" + "\\" + UNINSTALL_KEY

    return f"""param([string]$Target = "")
$ErrorActionPreference = 'SilentlyContinue'
if (-not $Target) {{ $Target = '{default_target()}' }}

Get-Process -Name 'ParadoxAgent' | Stop-Process -Force
Remove-Item -Recurse -Force (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Paradox')
Remove-Item -Force (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Paradox Desktop Agent.lnk')
Remove-ItemProperty -Path '{run_path}' -Name '{APP_ID}'
Remove-Item -Recurse -Force '{uninstall_path}'
Remove-Item -Recurse -Force (Join-Path $env:APPDATA 'Paradox')
Set-Location $env:TEMP
Remove-Item -Recurse -Force $Target
"""


def write_uninstaller(target: Path) -> Path:
    """.cmd wrapper (what the registry points at) + the PowerShell work."""
    ps1 = target / "uninstall.ps1"
    ps1.write_text(uninstall_script(), encoding="utf-8")

    cmd = target / "uninstall.cmd"
    cmd.write_text(
        "@echo off\r\n"
        "cd /d \"%TEMP%\"\r\n"
        'set "TEMPSCRIPT=%TEMP%\\paradox-uninstall.ps1"\r\n'
        'copy /y "%~dp0uninstall.ps1" "%TEMPSCRIPT%" >nul 2>&1\r\n'
        'powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMPSCRIPT%" -Target "%~dp0."\r\n'
        'del /q "%TEMPSCRIPT%" >nul 2>&1\r\n'
        "exit /b 0\r\n",
        encoding="ascii",
    )
    return cmd


# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

def check_payload() -> int:
    info = load_build_info()
    payload = payload_path()
    report = {
        "installer": info.get("version", "0.0.0"),
        "channel": info.get("channel", "dev"),
        "apiBase": info.get("apiBase", ""),
        "payload": str(payload),
        "payloadBytes": payload.stat().st_size if payload.exists() else None,
    }
    say(json.dumps(report, indent=2))
    if not payload.exists():
        return fail("the bundled agent is missing from this installer")
    if payload.stat().st_size < 1_000_000:
        return fail("the bundled agent is suspiciously small")
    if not info.get("apiBase"):
        return fail("this build has no Paradox server configured")
    say("payload ok")
    return 0


def install(options: dict) -> int:
    info = load_build_info()
    version = str(info.get("version") or "0.0.0")
    api_base = str(info.get("apiBase") or "").rstrip("/")

    if not api_base:
        return fail(
            "this build was packaged without a Paradox server address; "
            "rebuild it with PARADOX_API_BASE set"
        )

    payload = payload_path()
    if not payload.exists():
        return fail("the bundled agent is missing from this installer")

    # One installation per user: an existing install is updated in place, never
    # duplicated into a second directory.
    target = options.get("target") or installed_dir() or default_target()
    target = Path(target).expanduser()
    previous = installed_dir()
    if previous and previous != target and not options["silent"]:
        say(f"    an install already exists at {previous}; updating that one")
        target = previous

    if not options["silent"]:
        say(f"Paradox Desktop Agent {version} → {target}")
        say(f"Server: {api_base}")

    stop_running_agent()

    try:
        target.mkdir(parents=True, exist_ok=True)
        destination = target / AGENT_EXE
        shutil.copy2(payload, destination)
    except PermissionError:
        return fail(
            f"cannot write to {target}. Close Paradox Desktop Agent and try again, "
            "or install with /D=<another folder>."
        )
    except OSError as exc:
        return fail(f"cannot write to {target}: {exc}")

    arguments = f'--api "{api_base}"'

    try:
        create_shortcut(
            start_menu_dir() / f"{APP_NAME}.lnk", destination, arguments, target
        )
    except RuntimeError as exc:
        return fail(str(exc))

    if options["desktop_icon"]:
        try:
            create_shortcut(
                desktop_dir() / f"{APP_NAME}.lnk", destination, arguments, target
            )
        except RuntimeError as exc:
            # A missing desktop is not worth failing an install over
            say(f"    warning: {exc}")

    uninstaller = write_uninstaller(target)

    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY) as key:
            winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, APP_NAME)
            winreg.SetValueEx(key, "DisplayVersion", 0, winreg.REG_SZ, version)
            winreg.SetValueEx(key, "Publisher", 0, winreg.REG_SZ, PUBLISHER)
            winreg.SetValueEx(key, "InstallLocation", 0, winreg.REG_SZ, str(target))
            winreg.SetValueEx(key, "DisplayIcon", 0, winreg.REG_SZ, str(destination))
            winreg.SetValueEx(
                key,
                "UninstallString",
                0,
                winreg.REG_SZ,
                f'"{uninstaller}"',
            )
            winreg.SetValueEx(
                key, "QuietUninstallString", 0, winreg.REG_SZ, f'"{uninstaller}"'
            )
            winreg.SetValueEx(key, "NoModify", 0, winreg.REG_DWORD, 1)
            winreg.SetValueEx(key, "NoRepair", 0, winreg.REG_DWORD, 1)
            winreg.SetValueEx(
                key,
                "EstimatedSize",
                0,
                winreg.REG_DWORD,
                max(1, int(destination.stat().st_size / 1024)),
            )

        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            if options["autostart"]:
                winreg.SetValueEx(
                    key,
                    APP_ID,
                    0,
                    winreg.REG_SZ,
                    f'"{destination}" {arguments}',
                )
            else:
                try:
                    winreg.DeleteValue(key, APP_ID)
                except FileNotFoundError:
                    pass
    except OSError as exc:
        return fail(f"could not register the application: {exc}")

    launch = options["launch"]
    if launch is None:
        launch = not options["silent"]
    if launch:
        # Its own console: the agent prints the link code there, and nothing of
        # ours stays open waiting on the child's output.
        subprocess.Popen(
            [str(destination), "--api", api_base],
            cwd=str(target),
            close_fds=True,
            creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
        )

    say("")
    say(f"Paradox Desktop Agent {version} installed.")
    say(f"  {destination}")
    if launch:
        say("  The agent is open and will show a code to link this computer.")
    else:
        say("  Open “Paradox Desktop Agent” from the Start Menu to link this computer.")
    return 0


# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

def uninstall() -> int:
    target = installed_dir() or default_target()
    script = target / "uninstall.ps1"

    stop_running_agent()

    if script.exists():
        # Run from a copy: the script deletes the folder it lives in
        temporary = Path(tempfile.gettempdir()) / "paradox-uninstall.ps1"
        shutil.copy2(script, temporary)
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(temporary),
                "-Target",
                str(target),
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return fail(result.stderr.strip() or "the uninstaller failed")
        say("Paradox Desktop Agent removed.")
        return 0

    # No script (a broken install): remove what can be removed here
    shutil.rmtree(target, ignore_errors=True)
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY)
    except OSError:
        pass
    say("Paradox Desktop Agent removed.")
    return 0


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass

    options = parse_args(sys.argv[1:])

    if options["help"]:
        usage()
        return 0
    if options["check"]:
        return check_payload()
    if options["uninstall"]:
        return uninstall()

    try:
        return install(options)
    except Exception as exc:  # noqa: BLE001 - the installer must report, not trace
        if os.environ.get("PARADOX_INSTALLER_DEBUG"):
            raise
        return fail(f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
