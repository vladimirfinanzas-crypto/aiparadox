# Paradox Desktop Agent — build, install and release

The Desktop Agent is the local controller Godfather uses for tasks that must run
on the person's own computer. It is **not** a second Paradox: the web app stays
the product; this installs a small background app that polls Paradox over HTTPS
and executes the registered desktop actions.

The build produces a real Windows x64 installer (`ParadoxSetup.exe`), a release
manifest and a SHA-256, and `/api/desktop/download` serves exactly the file the
manifest names. There are two channels, and only one of them can ever become the
official download:

| Channel | Command | Files | Certificate | Official download |
| --- | --- | --- | --- | --- |
| **Development** | `npm run desktop:package` | `ParadoxSetup-dev.exe`, `desktop-dev.json` | not required | never |
| **Production** | `python desktop/package.py --channel production --api https://… --publish` | `ParadoxSetup.exe`, `desktop.json` | required, verified | yes, when published |

**Today there is no official release published.** The checkout has no
production manifest, so `/download/desktop` honestly says there is nothing to
download yet. A development build can be produced and tested locally right now
without a certificate or a public domain.

## Architecture

```
Paradox Web (Next.js)                 Desktop Agent (Windows)
─────────────────────                 ──────────────────────
Settings → Desktop Agent              ParadoxAgent.exe
  └─ enroll / pause / revoke            ├─ token in %APPDATA%\Paradox\device.json
Godfather (Trigger.dev task)            ├─ poll GET /api/pc/jobs  (HTTPS, outbound)
  └─ runPcAction → pc_jobs row          ├─ PyAutoGUI: screen / mouse / keyboard
Activity                                ├─ local browser: Chrome/Edge over CDP
                                        └─ POST result
```

- **No inbound port.** The agent polls; nothing connects into the machine.
- **Only registered actions.** `screenshot`, `move`, `click`, `type`, `press`,
  `hotkey`, `scroll`, `run` (open an allow-listed application — never a shell)
  and the `browser_*` actions. The allowlist lives in the agent, so the server
  cannot widen it.
- **Its own credential.** Each device gets a random token, stored hashed in
  `desktop_devices`; pause and revoke are enforced on every poll.

### Why a frozen Python agent instead of Tauri or Electron

The runtime Godfather drives is PyAutoGUI, which is Python. A Tauri or Electron
shell would need to ship a Python sidecar anyway, adding a second toolchain and
a second runtime without removing the first. `pyinstaller` freezes the agent and
its interpreter into one executable, so the person installs nothing else, and
the installer is another frozen program that carries the agent inside it.

## What is in the box

| File | What it is |
| --- | --- |
| `pc-agent/agent.py` | The agent itself: enrollment, polling, actions, allowlist |
| `pc-agent/browser_engine.py` | Optional local browser: launches Chrome/Edge per task over CDP and drives it with Playwright |
| `desktop/release_config.py` | The rules both channels share: channel names, server URL, version, certificate and publisher checks |
| `desktop/installer/install.py` | The installer, frozen into the setup executable |
| `desktop/package.py` | Build pipeline: validate → venv → agent → installer → sign → stage → optionally publish |
| `desktop/verify.py` | Checks artifacts, manifest, hash, signature and a real install/uninstall |
| `desktop/tests/` | Unit tests for the release configuration and manifest verification |
| `desktop/build.ps1` | Optional Inno Setup path (see “Alternative: Inno Setup”) |
| `desktop/installer.iss` | Inno Setup project, for teams that prefer MSI-like installers |
| `.github/workflows/desktop-agent.yml` | CI: development builds, production validation, explicit publication |
| `public/downloads/desktop.json` | The official release manifest the web reads (absent until a release is published) |

## Requirements to build

- Windows 10/11 x64
- Python 3.11+ (`python --version`) — only on the build machine
- No Inno Setup, WiX, Node or Rust is needed for the default pipeline
- An internet connection for the first build (pip) and, for a release, for
  timestamping

The build creates `desktop/.venv` and installs `pyautogui`, `pillow`,
`playwright` and `pyinstaller` into it. Nothing is installed system-wide, and no
browser is downloaded: the local browser engine drives the Chrome or Edge that
is already installed on the machine.

## Channels and commands

### Development build (no certificate, no public domain)

```bash
npm run desktop:package
# same as:
python desktop/package.py --channel development --api http://localhost:3000
```

- The server URL may be `http://localhost:3000`, `http://127.0.0.1:3000` or a
  real HTTPS staging host. Plain `http` is refused for any host that is not on
  this machine, so a device token never crosses the network in the clear.
- A placeholder (`example.com`, `*.example`, `*.test`, `*.invalid`) is refused
  in both channels.
- Artifacts: `desktop/out/release/ParadoxSetup-dev.exe`,
  `desktop/out/release/desktop-dev.json`, and the same pair copied into
  `public/downloads/` so the local app can serve it.
- No certificate is needed. Signing is skipped, and the manifest says so.
- `--self-sign` signs with a throwaway test certificate to exercise the signing
  path. Windows does not trust it and the manifest records `self-signed`. It is
  never a release.

### Production release (certificate and real HTTPS URL required)

```bash
# 1. Build and validate. Nothing is published by this command.
python desktop/package.py --channel production --version 1.2.0 \
  --api https://app.tudominio.com

# 2. When you have authorized the release, publish the verified pair.
python desktop/package.py --channel production --version 1.2.0 \
  --api https://app.tudominio.com --publish
```

The build refuses to run when:

- the version is not `MAJOR.MINOR.PATCH` (or is `0.x` on production);
- the server URL is empty, not HTTPS, local, private or a placeholder;
- no certificate is configured (`PARADOX_SIGN_PFX` / `PARADOX_SIGN_THUMBPRINT`);
- `PARADOX_SIGN_PUBLISHER` is not set;
- `--self-sign` is requested;
- the signature is not trusted by Windows after signing;
- the signing certificate is not the expected publisher;
- the file's SHA-256 or size do not match the manifest it just wrote.

Without `--publish`, the verified artifacts stay in `desktop/out/release/` and
nothing is written into `public/downloads`. With `--publish`, the pair is copied
there and hashed again after the copy.

## Commands

```bash
npm run desktop:dev             # run the agent from source against localhost:3000
npm run desktop:test            # python unit tests for release config + manifests
npm run desktop:build           # development build, staged only (--no-publish)
npm run desktop:package         # development build + publish its dev pair locally
npm run desktop:release         # production build, staged only (needs the cert)
npm run desktop:verify          # verify the development channel
npm run desktop:verify:release  # verify the production channel
python desktop/verify.py --channel development --install-test
```

`desktop/package.py` also accepts:

| Flag | Meaning |
| --- | --- |
| `--channel development\|production` | Channel (aliases `dev`, `release`) |
| `--version X.Y.Z` | Default: the agent's `VERSION` |
| `--api URL` | Server the installed agent connects to (`PARADOX_API_URL`) |
| `--download-url URL` | Optional HTTPS location of the installer (manifest `url`) |
| `--notes TEXT` | Release notes stored in the manifest |
| `--skip-agent` | Reuse `desktop/dist/ParadoxAgent.exe` (fast pipeline rehearsal) |
| `--no-publish` | Stage only; never touch `public/downloads` |
| `--publish` | Production: authorize copying the verified pair into `public/downloads` |
| `--self-sign` | Development only: sign with a throwaway test certificate |
| `--check` | Validate the configuration and exit `0` without building (CI uses this) |

Exit codes: `0` success, `1` build failure, `2` invalid configuration.

## What the build does

1. validates channel, version, server URL, download URL and signing
   configuration (before compiling anything);
2. creates `desktop/.venv` and installs the four dependencies;
3. freezes `pc-agent/agent.py` into `desktop/dist/ParadoxAgent.exe`;
4. runs `ParadoxAgent.exe --selftest` and stops if the bundle cannot import
   PyAutoGUI or enumerate the screen — a broken bundle never ships;
5. freezes `desktop/installer/install.py` into `desktop/dist/ParadoxSetup.exe`
   with the agent as a `payload` and a `build_info.json` carrying the version,
   the channel and the server address;
6. runs the setup executable with `/CHECK` to prove the payload is readable;
7. signs when configured (mandatory for production) and reads the signature
   back from the file, checking the publisher identity;
8. copies the **signed** installer into `desktop/out/release/` under the
   channel's name and computes its SHA-256 and size there;
9. writes the channel's manifest, its `.sha256`, and reads the pair back;
10. for a development build (or a production build with `--publish`), copies the
    pair into `public/downloads/` and hashes the file again.

Nothing is published until every step passed; a failure exits non-zero and
writes no manifest.

## The installer

`ParadoxSetup.exe` is a normal per-user Windows installer:

| Behaviour | Detail |
| --- | --- |
| Privileges | None. Everything is written under `%LOCALAPPDATA%` and `HKCU` |
| Default location | `%LOCALAPPDATA%\Paradox\Desktop Agent` |
| Shortcuts | Start Menu entry always; desktop shortcut unless `/NODESKTOPICON` |
| Autostart | Off by default; `/AUTOSTART` adds the `Run` entry |
| Uninstall | Listed in Settings → Apps, removes files, shortcuts, autostart, token |
| Duplicate installs | An existing install is updated in place, never duplicated |
| Running agent | Stopped before its files are replaced |
| Network | Opens no ports, contacts only the server baked into the build |
| Secrets | None inside the installer; the device token is obtained in the browser |

Switches:

```
ParadoxSetup.exe                    install (asks nothing it can decide)
ParadoxSetup.exe /S                 silent install
ParadoxSetup.exe /D=<dir>           custom folder
ParadoxSetup.exe /AUTOSTART         start the agent at sign-in
ParadoxSetup.exe /NODESKTOPICON     skip the desktop shortcut
ParadoxSetup.exe /LAUNCH /NOLAUNCH  start (or not) the agent afterwards
ParadoxSetup.exe /UNINSTALL         uninstall
ParadoxSetup.exe /CHECK             verify the bundled payload
```

The agent needs a server address; it is baked in at build time and written into
the shortcut arguments (`--api <url>`). It is not a secret.

## Manifests and the download endpoint

Each channel has its own manifest and its own installer, so they cannot
overwrite each other:

| Channel | Manifest | Installer | Read by |
| --- | --- | --- | --- |
| production | `public/downloads/desktop.json` | `ParadoxSetup.exe` | `/api/desktop/download` when `PARADOX_DESKTOP_CHANNEL` is unset or `production` |
| development | `public/downloads/desktop-dev.json` | `ParadoxSetup-dev.exe` | when `PARADOX_DESKTOP_CHANNEL=development`, or an explicit `?channel=development` |

A development manifest (generated by the current pipeline):

```json
{
  "product": "Paradox Desktop Agent",
  "version": "1.2.0",
  "file": "ParadoxSetup-dev.exe",
  "os": "Windows 10/11",
  "architecture": "x64",
  "sha256": "<sha256 of the final installer>",
  "bytes": 26970208,
  "releasedAt": "2026-10-23T21:46:06.437Z",
  "minimumAppVersion": "1.2.0",
  "channel": "development",
  "signed": false,
  "signature": { "status": "unsigned" }
}
```

An official manifest is identical with `channel: "production"`,
`signature.status: "verified"`, the signer subject/thumbprint, and optionally a
`url` pointing at an external host (for example the GitHub Release asset).

What the web enforces (`lib/desktop-release.ts`):

- the manifest must be the one for the configured channel, name that channel's
  installer, and carry a valid 64-hex SHA-256 and size;
- the production channel refuses a manifest whose signature is not `verified`;
- the named installer must exist in the deployment, or an `https` `url` must be
  set;
- before serving, `/api/desktop/download` re-hashes the file and returns `409`
  instead of sending bytes that no longer match;
- states are distinct and visible: `404` no build, `422` invalid manifest, `410`
  missing installer, `409` hash mismatch, `302` external URL, `200` the file;
- without a parameter the route serves only the deployment's own channel; an
  explicit, known `?channel=development|production` selects that channel by
  name (an unknown value is a `400`), and it goes through every rule above;
- the download pages (`decideOffer`) offer the deployment's own channel first
  and, only while no official release exists, a valid development build through
  an explicit channel link — always labeled as a development build, never as
  the official release.

Every response carries `x-release-version`, `x-release-channel`,
`x-release-signature` and (when it is a local file) `x-checksum-sha256`.

`ParadoxSetup.exe.sha256` (or the dev equivalent) is written next to the
installer for people and tooling that verify a download without the page.

### Signature states

| `signature.status` | Meaning | What the web shows |
| --- | --- | --- |
| `unsigned` | No Authenticode signature | “Sin firma · build de prueba” + SmartScreen warning |
| `self-signed` | Real signature, certificate Windows does not trust | “Firma de prueba (autofirmada)” + warning |
| `verified` | Signature whose chain Windows trusts | “Firmado” |

The state always comes from reading the built file (`Get-AuthenticodeSignature`),
never from what the build script hoped it did. Only a file with a real signer
certificate is ever called signed: Windows returns states like `UnknownError`
for unsigned files, and those are reported as `unsigned`. A digest mismatch
aborts the build.

## Code signing

Signing uses PowerShell's `Set-AuthenticodeSignature`, so no Windows SDK is
needed. A certificate is never stored in the repository and never printed.

```powershell
# Production: CA-issued certificate
$env:PARADOX_SIGN_PFX = "C:\path\to\certificate.pfx"
$env:PARADOX_SIGN_PASSWORD = "…"
$env:PARADOX_SIGN_PUBLISHER = "CN=Your Company SL, O=Your Company SL"
python desktop/package.py --channel production --version 1.2.0 --api https://app.tudominio.com

# Production: certificate already installed in CurrentUser\My
$env:PARADOX_SIGN_THUMBPRINT = "3038F1…"
$env:PARADOX_SIGN_PUBLISHER = "CN=Your Company SL, O=Your Company SL"
python desktop/package.py --channel production --version 1.2.0 --api https://app.tudominio.com

# Development: rehearse the signing path without any certificate
python desktop/package.py --channel development --self-sign --api http://localhost:3000
```

What the build does with `PARADOX_SIGN_PFX`: imports the certificate into the
current user's store (`Import-PfxCertificate`), signs with SHA-256 and an RFC
3161 timestamp (falling back to no timestamp if the authority is unreachable),
then **removes the private key from the store again**. The signature embeds the
certificate, so the file stays signed.

Rules the pipeline enforces:

- production requires `signature.status == "verified"`, which means Windows
  itself trusted the chain on the build machine;
- production also requires the certificate subject to match
  `PARADOX_SIGN_PUBLISHER`; a valid signature from the wrong company is a failed
  release;
- `--self-sign` and unsigned builds can only be development builds;
- the manifest records the signer subject, thumbprint, timestamp presence and
  the raw Windows status, so the claim can be checked after the fact.

If the certificate is hardware-backed or not exportable (a token or HSM), import
it into `CurrentUser\My` with the vendor's tool and use
`PARADOX_SIGN_THUMBPRINT`; the pipeline needs the thumbprint, not a file.

Honest caveats: signing does not remove every SmartScreen warning (reputation
still matters), and a certificate issued to an organisation will warn until it
accumulates downloads. Nothing here can honestly claim otherwise.

## CI

`.github/workflows/desktop-agent.yml` and the reusable action
`.github/actions/build-desktop/action.yml`:

| Job | Runs on | What it does |
| --- | --- | --- |
| `config` | every event | decides the channel, the version and whether publishing was requested |
| `unit-tests` | every event | `python -m unittest discover -s desktop/tests -t desktop` |
| `build-development` | `channel=development` | validates, builds, verifies, uploads the dev pair from `desktop/out/release/` |
| `build-release` | `channel=production`, environment `desktop-production` | same, plus `Get-AuthenticodeSignature` must return `Valid` and `Get-FileHash` must equal the manifest |
| `publish` | `channel=production` **and** `publish=true` | `contents: write`, re-verifies the artifact, attaches it to the tag's release, waits for the public URL, commits `public/downloads/desktop.json` |

Channel rules:

- a `desktop-vX.Y.Z` tag selects **production**. Any other tag shape fails in
  `config` with a message, before a runner is spent;
- a manual run with `channel=release` has no tag and therefore no version: it
  fails with “a production release needs a desktop-v<version> tag”. A tag is the
  only thing that names a release;
- a push or pull request touching `desktop/**` builds **development** with no
  certificate, no production URL and no secrets;
- `build-release` runs inside the `desktop-production` environment, so the
  owner can require a reviewer there, and its credentials exist only in that
  job;
- `publish` is the only job with `contents: write`. It refuses to run unless the
  actor is listed in the `PARADOX_RELEASE_OWNERS` variable (comma-separated
  GitHub logins), and the release was requested with `publish=true`.

Environment settings for `desktop-production`:

| Name | Kind | Value |
| --- | --- | --- |
| `PARADOX_API_URL` | variable | the public HTTPS address of Paradox |
| `PARADOX_SIGN_PUBLISHER` | variable | expected certificate subject, e.g. `CN=Paradox Technologies SL, O=Paradox Technologies SL` |
| `PARADOX_RELEASE_OWNERS` | variable | GitHub logins allowed to publish |
| `WINDOWS_CERT_PFX_BASE64` | secret | the `.pfx`, base64-encoded |
| `WINDOWS_CERT_PASSWORD` | secret | its password |

The workflow decodes the secret to a temporary file inside the runner, points
`PARADOX_SIGN_PFX` at it, and deletes it at the end of the job. No step echoes
the password, and the certificate never leaves the runner.

If the certificate is hardware-backed (non-exportable key), there is no PFX to
store: install the certificate into `CurrentUser\My` on a self-hosted runner
with the vendor tooling and switch the build to `PARADOX_SIGN_THUMBPRINT`, which
this pipeline already accepts.

## Distribution

`public/downloads` works for local development and for any host that serves
`public/` with the app. Keep in mind:

1. the installer is tens of megabytes — some serverless hosts cap static files.
   The official channel therefore hosts the installer on the GitHub Release and
   commits only `public/downloads/desktop.json`, whose `url` points at that
   asset; `/api/desktop/download` redirects to it (`302`);
2. binaries and `.sha256` files are gitignored, so a deployment must include
   them (CI artifact or a pre-deploy build) or the page correctly shows the
   download as unavailable;
3. `desktop-dev.json` is gitignored too: a development build is a local test
   artifact, not something a deployment should inherit.

### Production checklist

1. **Domain.** Decide the real public HTTPS address of Paradox. Do not put it in
   code: it is `PARADOX_PRODUCTION_API_URL` (CI variable) and `--api` locally.
2. **Certificate.** Obtain a CA-issued code-signing certificate (OV or EV) for
   the publisher name. Do not commit it.
3. **Secrets.** Store the `.pfx` base64 and its password as
   `WINDOWS_CERT_PFX_BASE64` and `WINDOWS_CERT_PASSWORD`, and the expected
   subject as `PARADOX_SIGN_PUBLISHER`, in the repository settings.
4. **Build the release.** Push a `desktop-v1.2.0` tag. The build job fails if
   the signature is not trusted, the publisher is not the expected one, the URL
   is not production HTTPS, or the file does not match its manifest.
5. **Publish explicitly.** Run the workflow for that tag with
   `channel=release, publish=true`, with an account listed in
   `PARADOX_RELEASE_OWNERS`. The publish job re-verifies the downloaded artifact,
   attaches the installer to the release, waits until the asset URL answers
   `200`, and only then commits the manifest.
6. **Serve it.** Set `PARADOX_DESKTOP_CHANNEL=production` (or leave it unset).
   The committed manifest redirects to the release asset; nothing binary needs to
   be in the deployment.
7. **Check the live page.** `/download/desktop` must show “Firmado” and the same
   SHA-256 as the release; `/api/desktop/download` must return the bytes with
   `x-checksum-sha256`.
8. **Smoke test.** Install on clean Windows 10 and Windows 11 machines, link the
   device, run one screenshot and one allow-listed `run`, then uninstall.
9. **Rollback.** Republish the previous verified pair; the URL never changes.

## Testing the queue without Godfather

A Godfather turn needs the Trigger.dev worker running. To exercise the local
half on its own, queue a job for whichever account has an online device:

```bash
node scripts/queue-desktop-test-job.mjs '{"kind":"screenshot"}'
node scripts/queue-desktop-test-job.mjs '{"kind":"run","command":"notepad"}'
node scripts/queue-desktop-test-job.mjs '{"kind":"run","command":"cmd"}'
```

The last one must come back `failed` with the allowlist message: that is the
security boundary working.

## Tests

```bash
npm run desktop:test            # 37 Python unit tests, no certificate needed
npm run desktop:verify          # artifacts + development manifest
npm run desktop:verify:release  # artifacts + production manifest (fails today)
python desktop/verify.py --channel development --install-test   # real install
```

The Python tests cover the rules that protect a release: channel aliases, server
URL validation (localhost allowed only in development, private and placeholder
hosts never), version rules, certificates and publisher identity, hash changes
after tampering, and manifest verification for both channels. They run on any OS;
the Authenticode and install checks need Windows.

## Adding a local tool Godfather can use

1. add the action to `perform()` in `pc-agent/agent.py` (and to the deny/allow
   lists if it launches anything);
2. add the matching `PcAction` variant in `db/schema.ts`;
3. expose it as a tool in `lib/agent-tools.ts` (`createComputerTools`) and
   register it in `lib/tool-registry.ts` with its risk and permissions;
4. rebuild the agent (`npm run desktop:package`), because the allowlist lives in
   the binary — an old installed agent will reject a new action, which is the
   intended behaviour.

## Limitations (honest list)

- **No official release is published.** There is no production manifest and no
  `ParadoxSetup.exe` pair in this checkout; `/download/desktop` says so. Only a
  development build can be produced today.
- **No CA-issued certificate yet.** Development builds are unsigned or signed
  with a throwaway test certificate; Windows does not trust the latter, and the
  manifest says `self-signed`. A production release needs the owner's
  certificate (see the production checklist).
- **No automatic updates yet.** An update means running the newer installer over
  the old one; the manifest carries version and checksum for a future updater.
- **No tray UI.** The agent runs in a console window that shows the link code
  and the actions it performs. That is the “agent is active” indicator today.
- **The local browser needs an installed Chrome or Edge.** The agent does not
  download a browser: it launches the one the person already has, with a
  dedicated profile per task, and connects Playwright over CDP to that loopback
  port. A machine without either browser, or a build without the Playwright
  driver, reports the `browser` capability as absent and the web app offers the
  cloud route instead. It never attaches to a Chrome window the person already
  had open.
- **The browser engine is one process per task.** Two tasks on one machine mean
  two windows; that isolation is intentional (separate profiles and cookies).
- **Windows only.** The installer and the actions are Windows-specific.
- **The graphics runtime cannot control a locked session**, an elevated app or
  anything Windows protects. PyAutoGUI drives the interactive desktop of the
  user who launched it.
- **The clean-VM installation was exercised on this Windows 11 machine**
  (install → self-test → link → screenshot → pause → resume → revoke →
  uninstall), not on a freshly imaged Windows 10 VM; the CI job repeats the
  install/uninstall cycle on `windows-latest`.
- **The CI workflow has not been executed here.** The workflow and the reusable
  action were written and reviewed in this environment, where no GitHub runner
  exists; the commands they call were executed locally on this Windows 11
  machine. The first CI run is pending.

## Alternative: Inno Setup

`desktop/build.ps1` + `desktop/installer.iss` remain for teams that prefer Inno
Setup (MSI-like uninstaller, wizard). They need Inno Setup 6 installed
(`winget install --id JRSoftware.InnoSetup`). The default pipeline above does
not depend on it, so a build machine without Inno Setup still produces a real
installer.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `configuration error: the server URL …` | Missing/invalid `--api`/`PARADOX_API_URL`; a production URL must be HTTPS and public |
| `configuration error: … placeholder` | An example domain was used; set the real server |
| `a production release needs a code-signing certificate` | No `PARADOX_SIGN_PFX`/`PARADOX_SIGN_THUMBPRINT`; development builds need none |
| `the signed certificate is not the expected publisher` | `PARADOX_SIGN_PUBLISHER` does not match the certificate subject |
| `a release build needs a signature Windows trusts` | The chain is not trusted on the build machine (import the root or use a CA-issued cert) |
| `the published file does not match the manifest checksum` | The file changed after signing/hashing; rebuild, never edit the manifest |
| “descarga no disponible” | No manifest for the configured channel, or the manifest names a missing file |
| `/api/desktop/download` returns 409 | The installer no longer matches its manifest SHA-256; republish |
| `/api/desktop/download` returns 422 | The manifest is invalid or a development build is offered as production |
| Installer says “cannot write to …” | The agent is running and holding its own file; close it and retry |
| Agent exits with “This device was revoked” | The device was revoked in Settings → Desktop Agent; run it again to link |
| Agent logs “cannot reach the app” | Wrong `--api` URL, or the web app is not running |
| `selftest failed: pyautogui` | The bundle is missing its runtime, or the session has no interactive desktop |
