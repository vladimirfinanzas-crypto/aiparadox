#!/usr/bin/env python3
"""
Paradox Desktop Agent — the local half of Godfather's computer access.

First run (no token stored yet):

    python agent.py --api https://your-app.example.com

The agent asks the backend for a short code, shows it, opens the approval page
in the browser and waits. Sign in, approve the code, and the agent receives its
own device token — stored under %APPDATA%\\Paradox (or ~/.config/paradox) with
owner-only permissions.

After that it runs in the foreground (the packaged build puts it in the tray)
and polls for work:

    python agent.py --api https://your-app.example.com

How it works
------------
The agent never listens on a port and nothing connects into the machine. It
polls GET /api/pc/jobs over HTTPS with its device token, performs the next
queued action, then POSTs the result back. That is why it works behind a home
router, a corporate firewall or a VPN with no configuration at all.

Only the small action vocabulary declared in the product's schema is executed —
screenshots, mouse, keyboard and an allow-listed command. There is no general
"run anything the model invents" path.

Controls the server enforces
----------------------------
- Paused device: the poll answers 403 and the agent idles.
- Revoked device: the poll answers 401 and the agent exits, deleting the token.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import pathlib
import platform
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

# The local browser engine is optional: a build without it still drives the
# mouse, the keyboard and the screen. It advertises the `browser` capability
# only when it can actually open a browser, so the server never offers a route
# this machine cannot take.
try:
    import browser_engine
except Exception:  # noqa: BLE001 - an optional module that is not bundled
    browser_engine = None  # type: ignore[assignment]

VERSION = "1.2.0"
_BASE_CAPABILITIES = "screen,mouse,keyboard,run"
CAPABILITIES = _BASE_CAPABILITIES + (
    ",browser" if browser_engine is not None and browser_engine.available() else ""
)
SCREENSHOT_MAX_BYTES = 1_500_000

# `run` launches an application — it never executes a command line. Shells and
# interpreters are excluded on purpose: Godfather does not get a terminal on
# someone's computer, only the ability to open a named app with plain
# arguments.
ALLOWED_APPS = {
    "notepad",
    "calc",
    "mspaint",
    "explorer",
    "code",
    "winword",
    "excel",
    "powerpnt",
}

FORBIDDEN_APPS = {
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "bash",
    "sh",
    "wscript",
    "cscript",
    "python",
    "python.exe",
    "node",
    "node.exe",
    "reg",
    "regedit",
    "schtasks",
}

CONFIG_DIR = pathlib.Path(
    os.environ.get("APPDATA") or pathlib.Path.home() / ".config"
) / "Paradox"
CONFIG_FILE = CONFIG_DIR / "device.json"


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def load_config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_config(data: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(data), encoding="utf-8")
    try:
        # Owner-only: the token is the only thing that authorizes this machine
        os.chmod(CONFIG_FILE, 0o600)
    except OSError:
        pass


def clear_config() -> None:
    try:
        CONFIG_FILE.unlink()
    except OSError:
        pass


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def request_json(api: str, path: str, token: str | None, payload=None, method=None):
    """One call to the product. Returns (status, parsed body or None)."""
    url = api.rstrip("/") + path
    data = None
    headers = {"User-Agent": f"ParadoxDesktopAgent/{VERSION}"}

    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["x-agent-version"] = VERSION
        headers["x-agent-capabilities"] = CAPABILITIES
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read()
            return res.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        body = exc.read()
        try:
            return exc.code, json.loads(body) if body else None
        except json.JSONDecodeError:
            return exc.code, None
    except (urllib.error.URLError, TimeoutError) as exc:
        raise ConnectionError(str(exc)) from exc


# ---------------------------------------------------------------------------
# Enrollment
# ---------------------------------------------------------------------------


def device_name() -> str:
    """The name the person sees in Settings → Desktop Agent."""
    name = os.environ.get("COMPUTERNAME")
    if not name and hasattr(os, "uname"):
        name = os.uname().nodename
    return (name or "This computer")[:80]


def enroll(api: str, open_browser: bool = True) -> dict:
    """Asks for a code, waits for the person to approve it, saves the token."""
    status, body = request_json(
        api,
        "/api/desktop/enrollments",
        None,
        payload={
            "deviceName": device_name(),
            # "Windows 11", not "win32 3.12.4": this is what the person reads
            "os": f"{platform.system()} {platform.release()}".strip(),
        },
        method="POST",
    )
    if status != 200 or not body:
        raise RuntimeError(f"Could not start the link ({status}). {body}")

    code = body["code"]
    approval_url = api.rstrip("/") + body["approvalPath"]

    print()
    print("  Connect Paradox to your computer")
    print()
    print(f"  Code:  {code}")
    print(f"  Open:  {approval_url}")
    print()
    print("  Sign in and approve the code. This window waits for it.")
    print()

    if open_browser:
        try:
            webbrowser.open(approval_url)
        except Exception:  # noqa: BLE001 - no browser is not fatal
            pass

    deadline = time.time() + 10 * 60
    delay = 2.0
    while time.time() < deadline:
        status, body = request_json(
            api, f"/api/desktop/enrollments/{code}", None
        )
        if status == 200 and body and body.get("token"):
            save_config(
                {"token": body["token"], "deviceId": body.get("deviceId"), "api": api}
            )
            print("  Device linked. This computer is now authorized.")
            return load_config()
        if status in (410, 404):
            raise RuntimeError("That code expired. Run the agent again.")
        if status == 409:
            raise RuntimeError("That code was already used. Run the agent again.")
        time.sleep(delay)

    raise RuntimeError("The code was not approved in time.")


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------


def pyautogui_module():
    try:
        import pyautogui  # noqa: PLC0415 - imported at use, not at start

        pyautogui.FAILSAFE = True
        return pyautogui
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise RuntimeError(
            "This build is missing its desktop automation runtime. Reinstall "
            "Paradox Desktop Agent."
        ) from exc


def screenshot_result():
    """The current screen as a PNG data URL, shrunk until it fits the cap."""
    pyautogui = pyautogui_module()
    original = pyautogui.screenshot()
    width, height = original.size

    for scale in (1.0, 0.8, 0.6, 0.5, 0.4):
        shot = (
            original
            if scale >= 1.0
            else original.resize((max(1, int(width * scale)), max(1, int(height * scale))))
        )
        # Pillow's tobytes() takes no format: encoding to PNG needs a buffer
        buffer = io.BytesIO()
        shot.save(buffer, format="PNG")
        data = buffer.getvalue()
        if len(data) <= SCREENSHOT_MAX_BYTES or scale <= 0.4:
            return {
                "width": shot.size[0],
                "height": shot.size[1],
                "image": f"data:image/png;base64,{base64.b64encode(data).decode('ascii')}",
            }

    raise RuntimeError("The screen could not be captured.")


def run_command(command, args):
    """Opens one allow-listed application. Never a shell, never a script."""
    name = (command or "").strip().lower()
    if name in FORBIDDEN_APPS:
        raise ValueError(
            f"{command} is a shell or interpreter, and this agent does not give "
            "Godfather a terminal."
        )
    if name not in ALLOWED_APPS:
        raise ValueError(
            f"{command} is not in the allowed applications: "
            + ", ".join(sorted(ALLOWED_APPS))
        )

    safe_args = [str(arg) for arg in (args or [])][:3]
    if any(len(arg) > 200 for arg in safe_args):
        raise ValueError("Argument too long.")

    # Popen, not run: launching a GUI app is the goal, waiting for it is not
    proc = subprocess.Popen(
        [command, *safe_args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        shell=False,
    )
    return {"launched": command, "pid": proc.pid}


# One engine per agent process: it owns every browser window this machine is
# driving, one per execution task, and closes them all when the agent stops.
_browser_engine = None


def browser_engine_instance():
    global _browser_engine
    if browser_engine is None:
        raise RuntimeError(
            "This Desktop Agent build has no local browser engine. Update "
            "Paradox Desktop Agent, or run the task in the cloud browser."
        )
    if _browser_engine is None:
        _browser_engine = browser_engine.BrowserEngine()
    return _browser_engine


def shutdown_browser_engine() -> None:
    global _browser_engine
    if _browser_engine is not None:
        try:
            _browser_engine.close_all()
        except Exception:  # noqa: BLE001 - shutting down must not raise
            pass
        _browser_engine = None


def perform(action: dict):
    """Carries out one job from the product."""
    kind = action.get("kind")

    # Web work runs in a real browser through the local engine. It never falls
    # back to clicking with the mouse: a coordinate click on a page is not a
    # reliable substitute for driving the DOM.
    if isinstance(kind, str) and kind.startswith("browser_"):
        return browser_engine_instance().handle(action)

    # Opening an app needs no screen automation, so it works on a machine whose
    # GUI stack is unavailable (a locked session, for instance).
    if kind == "run":
        return run_command(action["command"], action.get("args"))

    pyautogui = pyautogui_module()

    if kind == "screenshot":
        return screenshot_result()
    if kind == "move":
        pyautogui.moveTo(action["x"], action["y"], duration=0.15)
        return {"x": action["x"], "y": action["y"]}
    if kind == "click":
        pyautogui.click(action["x"], action["y"], button=action.get("button", "left"))
        return {"x": action["x"], "y": action["y"]}
    if kind == "type":
        # newlines have to be pressed, not typed, or they do nothing
        for chunk in action["text"].split("\n"):
            if chunk:
                pyautogui.write(chunk, interval=0.02)
            pyautogui.press("enter")
        return {"typed": len(action["text"])}
    if kind == "press":
        pyautogui.press(action["key"])
        return {"key": action["key"]}
    if kind == "hotkey":
        pyautogui.hotkey(*action["keys"])
        return {"keys": action["keys"]}
    if kind == "scroll":
        pyautogui.hscroll(int(action["dx"]))
        pyautogui.scroll(int(action["dy"]))
        return {"dx": action["dx"], "dy": action["dy"]}

    raise ValueError(f"Unknown action kind: {kind!r}")


# ---------------------------------------------------------------------------
# Self test
# ---------------------------------------------------------------------------


def selftest() -> int:
    """Proves the packaged build carries its runtime. Used by the build script
    and by anyone checking a fresh install: it needs no server and no token."""
    report = {
        "agent": VERSION,
        "frozen": bool(getattr(sys, "frozen", False)),
        "python": platform.python_version(),
        "platform": f"{platform.system()} {platform.release()}",
        "configDir": str(CONFIG_DIR),
        "capabilities": CAPABILITIES.split(","),
    }

    failures = []
    try:
        import pyautogui  # noqa: PLC0415 - the point of the check

        report["pyautogui"] = getattr(pyautogui, "__version__", "bundled")
        report["screen"] = list(pyautogui.size())
    except Exception as exc:  # noqa: BLE001 - a missing GUI session is reported
        report["pyautogui"] = f"unavailable: {exc}"
        failures.append("pyautogui")

    # The browser engine is optional, so it is reported without failing the
    # check: its absence only removes the local browsing route.
    report["browser"] = (
        browser_engine.describe()
        if browser_engine is not None
        else {"available": False, "reason": "browser_engine.py is not bundled"}
    )

    print(json.dumps(report, indent=2))
    if failures:
        print(f"selftest failed: {', '.join(failures)}", file=sys.stderr)
        return 1
    print("selftest ok")
    return 0


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def main() -> int:
    # Live output even when the agent's console is redirected to a file
    try:
        sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
        sys.stderr.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass

    parser = argparse.ArgumentParser(description="Paradox Desktop Agent")
    parser.add_argument("--api", help="Base URL of the app")
    parser.add_argument(
        "--token",
        help="Device token (otherwise the stored one, or a new link is started)",
    )
    parser.add_argument(
        "--interval", type=float, default=1.5, help="Seconds between polls"
    )
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="Check the bundled runtime and exit (no server needed)",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not open the approval page; print the link instead",
    )
    args = parser.parse_args()

    if args.selftest:
        return selftest()

    if not args.api:
        parser.error("--api is required (or use --selftest)")

    api = args.api.rstrip("/")
    config = load_config()

    token = args.token or config.get("token")
    if not token:
        try:
            token = enroll(api, open_browser=not args.no_browser)["token"]
        except (RuntimeError, ConnectionError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
    elif config.get("api") and config["api"].rstrip("/") != api:
        # The token belongs to another deployment: never send it elsewhere
        print(
            f"error: this device is linked to {config['api']}, not {api}. "
            "Revoke it there first or pass a token for this deployment.",
            file=sys.stderr,
        )
        return 1

    print(f"Paradox Desktop Agent {VERSION} polling {api} (Ctrl+C to stop)")
    failures = 0

    while True:
        try:
            status, job = request_json(api, "/api/pc/jobs", token)

            if status == 401:
                print(
                    "This device was revoked. Run the agent again to link it.",
                    file=sys.stderr,
                )
                # A revoked device must not keep a browser under Godfather's
                # control open on the machine.
                shutdown_browser_engine()
                clear_config()
                return 1

            if status == 403:
                # Paused from the web: keep the connection, take no work
                time.sleep(max(args.interval, 3.0))
                continue

            if status in (204, 404) or job is None:
                failures = 0
                time.sleep(args.interval)
                continue

            job_id = job["id"]
            try:
                result = perform(job.get("action") or {})
            except Exception as exc:  # noqa: BLE001 - reported, never fatal
                request_json(
                    api,
                    "/api/pc/jobs",
                    token,
                    payload={"id": job_id, "ok": False, "error": str(exc)[:500]},
                )
                print(f"job {job_id} failed: {exc}", file=sys.stderr)
                continue

            request_json(
                api,
                "/api/pc/jobs",
                token,
                payload={"id": job_id, "ok": True, "result": result},
            )
            print(f"job {job_id} done ({(job.get('action') or {}).get('kind')})")

        except ConnectionError as exc:
            # The app is unreachable; back off instead of spinning
            failures += 1
            time.sleep(min(30, args.interval * (2 ** min(failures, 5))))
            print(f"cannot reach the app: {exc}", file=sys.stderr)
        except KeyboardInterrupt:
            print("\nstopped")
            shutdown_browser_engine()
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
