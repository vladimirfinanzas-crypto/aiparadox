# Godfather: browser and desktop execution

Godfather is the only agent the person talks to. Behind it sit two places where
web work can run, and one place where desktop work runs:

| Environment | Runs on | Reached through |
| --- | --- | --- |
| **Cloud browser** | Browserbase, a managed Chromium | Playwright over CDP |
| **Local browser** | The person's own computer | Paradox Desktop Agent (Playwright over CDP to a browser the agent launches) |
| **Desktop (GUI)** | The person's own computer | Paradox Desktop Agent, PyAutoGUI |

There is **no embedded live view**: the chat does not stream a remote screen. It
shows what Godfather did (states, tabs, results), not a browser window.

## 1. Where a task runs is the person's decision

A task that needs a browser is a row in `execution_tasks`. It is created before
anything runs, and it starts in `awaiting_execution_environment` unless the
person already named an environment.

Flow:

1. Godfather calls `request_execution_environment` before any `browser_*` tool.
2. `lib/execution-router.ts` decides: answer from an API, ask, run where the
   person said, or report that the chosen environment is unavailable.
3. If it asks, the chat renders `ExecutionEnvironmentCard` with real buttons:
   **Navegador cloud — Browserbase**, **Navegador de mi PC**, **Cancelar**.
4. The click goes to the `resolveExecutionEnvironment` server action, which
   re-checks ownership and status, records the choice on the row, and returns
   the line the chat sends to resume the turn.
5. Godfather continues; the `browser_*` tools act in the environment recorded on
   the task and in that task's own tab.

Rules enforced in code, not only in prompts:

- No task, or a task with no environment, means every `browser_*` tool throws
  `NO_ENVIRONMENT_ERROR` telling the model to ask first. Nothing is opened.
- A second click on the same card is answered with what was already decided; it
  cannot start the work twice (`checkResolution`).
- A task id from another account does not exist for that person.
- Choosing "mi PC" when no computer is online returns the reason and the path to
  connect one. It never falls back to Browserbase.
- The selection is a database row, so refreshing the page does not lose it.

## 2. Sessions, tabs and contexts

`lib/browser-sessions.ts` keeps **one session per execution task**, never a
process-wide "current page":

- two tasks in the same chat get two sessions,
- a click that opens a tab adopts it as that task's current tab,
- `browser_tabs` lists the tabs with ids, and every tool accepts `pageId`,
- sessions are closed when the turn ends (`closeConversationBrowsers`) or when
  the task is done, which also releases the paid cloud session.

Local sessions are bound to the device that opened them (`pc_jobs.device_id`), so
a task never continues on a different computer.

## 3. Cloud browser (Browserbase)

Required configuration (server, never sent to the browser):

```
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=
```

Per task, the server creates a Browserbase session, connects with Playwright over
CDP, drives it, and calls `REQUEST_RELEASE` when closing so billing stops. Sessions
are never shared between people or between tasks.

What it cannot do: read the person's local cookies, logins or files. It is an
independent browser; only an explicit, authorized mechanism could move data
across, and none exists.

## 4. Local browser (the person's PC)

The Desktop Agent polls for work; nothing connects into the machine. Because of
that, the server cannot drive a Playwright instance on the device — the agent
does the driving itself:

1. Server queues a job (`browser_open`, `browser_navigate`, …) for that device.
2. The agent launches Chrome or Edge with `--remote-debugging-port` on
   `127.0.0.1`, in a **per-task profile** under `%APPDATA%\Paradox\browser\<task>`.
3. The agent connects Playwright over CDP to that loopback port and performs the
   action, returning `pageId`, `url`, `title`, `text` and the tab list.
4. On `browser_close` the browser is terminated and the profile deleted.

It never attaches to a Chrome window the person already had open: that is not
reliable and would give Godfather the person's own browsing session.

The capability is advertised only when the build can actually do it
(`playwright` importable + a Chrome/Edge binary found). Otherwise the device
reports `screen,mouse,keyboard,run` and the server does not offer the local
browser route.

Build requirement (already wired in `desktop/build.ps1` and `desktop/package.py`):

```
pyautogui  pillow  playwright  pyinstaller
```

`--collect-all playwright` is needed because the driver is a Node binary
PyInstaller cannot infer. No browser is downloaded: the installed Chrome/Edge is
used. `PARADOX_BROWSER_PATH` overrides executable discovery.

Check a fresh install with:

```
ParadoxAgent.exe --selftest
```

It prints whether the screen tools and the browser engine are available.

## 5. Desktop control (PyAutoGUI)

`pc_*` tools (screen, mouse, keyboard, allow-listed application launch) run only
for a task whose environment is the person's computer. They are not a web
navigation engine: a coordinate click is not a substitute for driving the DOM,
and Godfather is told so.

Safety:

- pairing binds a device to one account; tokens are stored hashed,
- pause stops new work; revoke deletes the token and the agent exits,
- jobs are scoped by user **and** device,
- `run` accepts an allow-list of applications, never a shell,
- browser URLs are restricted to `http`/`https`,
- page text is treated as untrusted data by every prompt that receives it.

## 6. Permissions and approvals

Environment selection is **not** permission. Purchases, sending messages,
publishing, deleting data and anything irreversible still need an explicit yes in
the conversation, and the tool descriptions say so.

## 7. Observability

Each task writes its own event trail (`execution_tasks.events`): created,
environment selected, session opened, each step with its duration, errors, and how
it ended. Every tool call is also recorded in `executions` by
`wrapToolsForExecution`. Activity lists both, and a task links back to its chat.

Which environment was used and why is stored on the task (`environment`,
`reason`), so "why did it browse in the cloud?" has an answer.

## 8. Tests

```
npm test
```

Relevant specs:

- `lib/__tests__/execution-router.test.ts` — asking, never running before the
  answer, explicit environments, unavailability, cancellation, ownership,
  duplicate clicks.
- `lib/__tests__/browser-sessions.test.ts` — one session per task, no sharing,
  race on open, environment change, scoped closing, URL safety, timeouts.
- `lib/__tests__/tool-registry.test.ts` — registry metadata, both environments,
  internal groups hidden from the model's availability report.

Not covered by automated tests (needs real credentials or a real machine): a live
Browserbase session, a live Desktop Agent session, and the full sign-in flow.

## 9. Known limitations

- The cloud browser needs a Browserbase key; without it the route is reported as
  unavailable (it is not simulated).
- The local browser needs a Desktop Agent build that bundles `playwright`. Older
  builds keep the GUI tools and report the browser route as unavailable; the
  person updates the agent or chooses the cloud.
- The Desktop Agent drives a browser process per task; many simultaneous tasks on
  one machine mean several windows, which is intentional isolation.
- Live View shows each environment through the mechanism it actually has; see
  the next section for what that is, and what it is not.

## 10. Live View

The floating **Live View** panel shows the session behind the current work and
lets the person watch it. It reads three endpoints, all session-authenticated
and all scoped to the caller's own rows:

| Endpoint | What it answers |
|---|---|
| `GET /api/live/session` | Which session is worth showing: the newest browser task still working, or the last one if it ended in the last 30 minutes |
| `GET /api/live/session/viewer?taskId=…` | Browserbase's own live-view URLs for a running **cloud** session |
| `POST /api/live/session/snapshot` | One screenshot of the **local** browser window, through the Desktop Agent's job queue |

### Why the two environments look different

The browser session is created and held inside the Trigger.dev task that opened
it (`lib/browser-sessions.ts` keeps it in memory), so a web route cannot reach
into it and take a picture. Each environment therefore uses the mechanism it
really has, and the panel labels which one is on screen:

- **Cloud (Browserbase).** `sessions.debug(id, { expiresIn })` returns their own
  debugger URLs (SDK `SessionLiveURLs`). We open that link in a new tab with
  `noopener`, issue it only to the person whose task owns the session, and keep
  the TTL short (10 minutes). Paradox does not build a second viewer: the browser
  runs on Browserbase's machines and they own the stream. If the session already
  ended, the route answers `410 session_ended` and the panel says so.
- **Local (Desktop Agent).** The agent has no inbound connection — it polls a job
  queue over HTTPS — so there is no video stream to show. The panel asks for a
  screenshot (`browser_screenshot` with the task's session key), every 6 seconds
  while it is open, and labels it *capturas, no vídeo en directo*. Only the
  Paradox-controlled browser window is requested, never the person's whole
  desktop.

### States

`sin sesión` · `conectando` (task queued) · `activo` · `pausado` (the person
paused their Desktop Agent) · `desconectado` (the computer stopped answering) ·
`finalizada` · `error`. Requests time out after 12 seconds with a retry button,
so the panel never spins forever on a dead server.

### Security

- The caller only names a **task id**; the server resolves the session from rows
  scoped to their user id. A foreign task answers `404`, never `403`, so the
  route cannot be used to probe for other accounts' tasks.
- `BROWSERBASE_API_KEY` never reaches the browser; only the provider's own
  expiring URLs are returned, and every response is `cache-control: no-store`.
- Nothing is minted before ownership is verified: the tests assert that a
  foreign or unsigned caller produces zero provider calls.

### Covered by tests

`lib/__tests__/live-session-view.test.ts` (the state mapping) and
`lib/__tests__/live-session-routes.test.ts` (ownership, environment routing,
absence of provider calls for foreign callers, a session that ended, and the
three local failure modes). A real Browserbase live view and a real Desktop
Agent screenshot still need live credentials and a real machine.
