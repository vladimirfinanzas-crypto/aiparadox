"""
Paradox Desktop Agent — local browser engine.

Godfather never connects *into* the person's machine: the machine polls for
work. That is why the local browser cannot be "a Playwright the server drives".
Instead the agent runs Playwright itself, locally, against a browser it launches
with its own isolated profile:

    agent ── launches Chrome/Edge with --remote-debugging-port on 127.0.0.1
          ── Playwright connects over CDP to that loopback port
          ── performs the action and returns structured results
          ── server, tab, title and text go back to Paradox over HTTPS

Each execution task gets its own browser process and its own profile directory,
so two tasks on the same computer cannot see each other's tabs, cookies or
logins. The profile is deleted when the task closes.

Limits, on purpose:

- only http and https pages can be opened (no file://, no chrome://, no
  devtools URLs),
- the page text returned is capped, and nothing is written to disk except the
  temporary profile,
- if Playwright is not bundled in this build the engine reports that clearly
  instead of pretending it can browse.

The import is deferred: a build without the optional dependency still runs the
mouse, keyboard and screenshot tools.
"""

from __future__ import annotations

import base64
import os
import pathlib
import re
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_TEXT = 8000
MAX_TARGET = 300
MAX_TEXT_INPUT = 4000
MAX_TABS = 12
NAVIGATION_TIMEOUT_MS = 30000
ACTION_TIMEOUT_MS = 15000

_SESSION_KEY = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

PROFILE_ROOT = pathlib.Path(
    os.environ.get("APPDATA") or pathlib.Path.home() / ".config"
) / "Paradox" / "browser"

# Where Chrome and Edge usually live. PARADOX_BROWSER_PATH overrides it.
CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def available() -> bool:
    """True when this build can drive a browser at all."""
    if not browser_path():
        return False
    try:
        import playwright.sync_api  # noqa: F401,PLC0415 - the point of the check
    except Exception:  # noqa: BLE001 - any import failure means "not bundled"
        return False
    return True


def describe() -> dict:
    """What the selftest and the device capabilities report."""
    path = browser_path()
    try:
        import playwright  # noqa: PLC0415

        version = getattr(playwright, "__version__", "bundled")
    except Exception as exc:  # noqa: BLE001
        version = f"unavailable: {exc}"

    return {
        "available": available(),
        "browser": path or "not found",
        "playwright": version,
        "profileRoot": str(PROFILE_ROOT),
    }


def browser_path() -> str | None:
    override = os.environ.get("PARADOX_BROWSER_PATH")
    if override and pathlib.Path(override).exists():
        return override
    for candidate in CANDIDATES:
        if pathlib.Path(candidate).exists():
            return candidate
    for name in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge"):
        found = shutil.which(name)
        if found:
            return found
    return None


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _safe_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Only complete http or https URLs can be opened.")
    return url


def _clip(text: str) -> str:
    cleaned = (text or "").strip()
    if len(cleaned) <= MAX_TEXT:
        return cleaned
    return cleaned[:MAX_TEXT] + f"\n… {len(cleaned) - MAX_TEXT} more characters"


class _Session:
    """One task's browser: its own process, profile, pages and current tab."""

    def __init__(self, key: str, playwright, executable: str, profile: pathlib.Path):
        self.key = key
        self.playwright = playwright
        self.profile = profile
        self.pages: dict[str, object] = {}
        self.current = ""
        self.counter = 0

        port = _free_port()
        profile.mkdir(parents=True, exist_ok=True)

        args = [
            executable,
            f"--remote-debugging-port={port}",
            # Chrome 111+ refuses CDP websockets from unknown origins
            "--remote-allow-origins=*",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=Translate",
            "--new-window",
            "about:blank",
        ]
        self.process = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=False,
        )

        self._wait_for_port(port)
        self.browser = playwright.chromium.connect_over_cdp(
            f"http://127.0.0.1:{port}"
        )
        self.context = (
            self.browser.contexts[0] if self.browser.contexts else self.browser.new_context()
        )
        # A page the person (or the site) opens belongs to this task only.
        self.context.on("page", self._adopt)
        for page in self.context.pages()[:MAX_TABS]:
            self._adopt(page)
        if not self.pages:
            self._adopt(self.context.new_page())

    def _wait_for_port(self, port: int) -> None:
        deadline = time.time() + 20
        url = f"http://127.0.0.1:{port}/json/version"
        while time.time() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError("The browser closed before it could be controlled.")
            try:
                with urllib.request.urlopen(url, timeout=1) as response:
                    if response.status == 200:
                        return
            except (urllib.error.URLError, TimeoutError, OSError):
                time.sleep(0.25)
        raise RuntimeError("The browser did not expose its debugging port in time.")

    def _adopt(self, page) -> None:
        for known in self.pages.values():
            if known is page:
                return
        self.counter += 1
        page_id = f"tab-{self.counter}"
        self.pages[page_id] = page
        self.current = page_id

    def _page(self, page_id: str | None):
        chosen = page_id or self.current
        page = self.pages.get(chosen)
        if page is None:
            raise ValueError(
                f"This task has no tab '{chosen}'. Open one, or list them first."
            )
        self.current = chosen
        return page

    def _tabs(self) -> list[dict]:
        tabs = []
        for page_id, page in self.pages.items():
            tabs.append(
                {
                    "id": page_id,
                    "url": page.url,
                    "title": _safe_title(page),
                    "current": page_id == self.current,
                }
            )
        return tabs

    def observe(self, page) -> dict:
        try:
            text = page.locator("body").inner_text(timeout=5000)
        except Exception:  # noqa: BLE001 - an empty page is not a failure
            text = ""
        return {
            "pageId": self.current,
            "url": page.url,
            "title": _safe_title(page),
            "text": _clip(text),
            "tabs": self._tabs(),
        }

    # -- actions ---------------------------------------------------------

    def navigate(self, url: str, page_id: str | None) -> dict:
        page = self._page(page_id)
        page.goto(_safe_url(url), wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)
        return self.observe(self._current_page())

    def read(self, page_id: str | None) -> dict:
        page = self._page(page_id)
        try:
            page.wait_for_load_state("domcontentloaded", timeout=10000)
        except Exception:  # noqa: BLE001 - already loaded is fine
            pass
        return self.observe(page)

    def select(self, page_id: str) -> dict:
        page = self._page(page_id)
        try:
            page.bring_to_front()
        except Exception:  # noqa: BLE001 - focus is best effort
            pass
        return self.observe(page)

    def click(self, target: str, page_id: str | None) -> dict:
        page = self._page(page_id)
        before = set(self.pages)
        self._locate(page, target).click(timeout=ACTION_TIMEOUT_MS)
        try:
            page.wait_for_load_state("domcontentloaded", timeout=10000)
        except Exception:  # noqa: BLE001
            pass
        opened = [key for key in self.pages if key not in before]
        if opened:
            self.current = opened[-1]
        return self.observe(self._current_page())

    def type_text(self, target: str, text: str, submit: bool | None, page_id: str | None) -> dict:
        page = self._page(page_id)
        field = self._locate(page, target)
        field.fill(text[:MAX_TEXT_INPUT], timeout=ACTION_TIMEOUT_MS)
        if submit:
            field.press("Enter")
            try:
                page.wait_for_load_state("domcontentloaded", timeout=10000)
            except Exception:  # noqa: BLE001
                pass
        return self.observe(page)

    def press(self, key: str, page_id: str | None) -> dict:
        page = self._page(page_id)
        page.keyboard.press(key)
        return self.observe(page)

    def back(self, page_id: str | None) -> dict:
        page = self._page(page_id)
        try:
            page.go_back(wait_until="domcontentloaded")
        except Exception:  # noqa: BLE001 - no history is not an error
            pass
        return self.observe(page)

    def screenshot(self, page_id: str | None) -> dict:
        page = self._page(page_id)
        try:
            data = page.screenshot(type="png")
        except Exception:  # noqa: BLE001 - fall back to a smaller JPEG
            data = page.screenshot(type="jpeg", quality=60)
            media = "jpeg"
        else:
            media = "png"

        if len(data) > 1_500_000:
            data = page.screenshot(type="jpeg", quality=55)
            media = "jpeg"

        size = page.viewport_size or {}
        return {
            "pageId": self.current,
            "url": page.url,
            "width": size.get("width"),
            "height": size.get("height"),
            "image": f"data:image/{media};base64,{base64.b64encode(data).decode('ascii')}",
        }

    def _current_page(self):
        return self._page(None)

    def _locate(self, page, target: str):
        """Semantic first: role, label, placeholder, text, then a selector."""
        if not target or len(target) > MAX_TARGET:
            raise ValueError("Describe the element in fewer characters.")

        attempts = [
            lambda: page.get_by_role("button", name=target, exact=False).first,
            lambda: page.get_by_role("link", name=target, exact=False).first,
            lambda: page.get_by_label(target, exact=False).first,
            lambda: page.get_by_placeholder(target, exact=False).first,
            lambda: page.get_by_text(target, exact=False).first,
            lambda: page.locator(target).first,
        ]

        for attempt in attempts:
            try:
                candidate = attempt()
            except Exception:  # noqa: BLE001 - invalid selector for that strategy
                continue
            try:
                if candidate.count() > 0:
                    return candidate
            except Exception:  # noqa: BLE001
                continue

        raise ValueError(f'Nothing on the page matches "{target}".')

    def close(self) -> None:
        try:
            self.browser.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
        except Exception:  # noqa: BLE001
            pass
        # Nothing from this task survives: no cookies, no history, no logins
        shutil.rmtree(self.profile, ignore_errors=True)


def _safe_title(page) -> str:
    try:
        return page.title()
    except Exception:  # noqa: BLE001
        return ""


class BrowserEngine:
    """Owns one browser process per execution task."""

    def __init__(self) -> None:
        self._playwright = None
        self._sessions: dict[str, _Session] = {}

    def _ensure_playwright(self):
        if self._playwright is not None:
            return self._playwright
        try:
            from playwright.sync_api import sync_playwright  # noqa: PLC0415
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                "This Desktop Agent build does not include its local browser "
                "engine. Update Paradox Desktop Agent, or run the task in the "
                "cloud browser instead."
            ) from exc

        self._playwright = sync_playwright().start()
        return self._playwright

    def _session(self, key: str) -> _Session:
        if not _SESSION_KEY.match(key or ""):
            raise ValueError("Invalid browser session key.")
        existing = self._sessions.get(key)
        if existing is not None:
            return existing

        executable = browser_path()
        if not executable:
            raise RuntimeError(
                "No Chrome or Edge installation was found on this computer, so the "
                "local browser cannot open. Install a Chromium browser, or run the "
                "task in the cloud browser."
            )

        session = _Session(
            key,
            self._ensure_playwright(),
            executable,
            PROFILE_ROOT / key,
        )
        self._sessions[key] = session
        return session

    def handle(self, action: dict) -> dict:
        """Carries out one browser_* job from the product."""
        kind = action.get("kind", "")
        key = str(action.get("sessionKey") or "")

        if kind == "browser_close":
            session = self._sessions.pop(key, None)
            if session is not None:
                session.close()
            return {"closed": key}

        if kind not in {
            "browser_open",
            "browser_navigate",
            "browser_read",
            "browser_tabs",
            "browser_select_tab",
            "browser_click",
            "browser_type",
            "browser_press",
            "browser_back",
            "browser_screenshot",
        }:
            raise ValueError(f"Unknown browser action: {kind!r}")

        session = self._session(key)
        page_id = action.get("pageId")

        if kind == "browser_open":
            if action.get("url"):
                return session.navigate(str(action["url"]), page_id)
            return session.read(page_id)
        if kind == "browser_navigate":
            return session.navigate(str(action.get("url") or ""), page_id)
        if kind == "browser_read":
            return session.read(page_id)
        if kind == "browser_tabs":
            return session.read(page_id)
        if kind == "browser_select_tab":
            if not page_id:
                raise ValueError("browser_select_tab needs a pageId.")
            return session.select(str(page_id))
        if kind == "browser_click":
            return session.click(str(action.get("target") or ""), page_id)
        if kind == "browser_type":
            return session.type_text(
                str(action.get("target") or ""),
                str(action.get("text") or ""),
                bool(action.get("submit")),
                page_id,
            )
        if kind == "browser_press":
            return session.press(str(action.get("key") or ""), page_id)
        if kind == "browser_back":
            return session.back(page_id)
        if kind == "browser_screenshot":
            return session.screenshot(page_id)

        raise ValueError(f"Unknown browser action: {kind!r}")

    def close_all(self) -> None:
        for session in list(self._sessions.values()):
            session.close()
        self._sessions.clear()
        if self._playwright is not None:
            try:
                self._playwright.stop()
            except Exception:  # noqa: BLE001
                pass
            self._playwright = None
