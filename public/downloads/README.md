# Published Desktop Agent builds

This folder holds what `/api/desktop/download` serves. There are two channels
and they never share files:

| Channel | Manifest | Installer | Served when |
| --- | --- | --- | --- |
| production | `desktop.json` | `ParadoxSetup.exe` | `PARADOX_DESKTOP_CHANNEL` unset or `production` |
| development | `desktop-dev.json` | `ParadoxSetup-dev.exe` | `PARADOX_DESKTOP_CHANNEL=development` only |

**Current state of this checkout: no official release is published.** There is
no `desktop.json` and no `ParadoxSetup.exe`, so `/download/desktop` correctly
says the download is not available yet. That is not a bug; it is the honest
state until the owner configures the production certificate and URL.

Rules that keep this honest:

- the binary and the manifest are written by `desktop/package.py`, never by hand;
- a development build writes `desktop-dev.json` and `ParadoxSetup-dev.exe`; it
  can never overwrite the official pair;
- the official pair is written only by a production build, and only with
  `--publish`;
- the manifest's `sha256` and `bytes` always match the published file, and
  `desktop/verify.py --channel <channel>` fails if they drift;
- `/api/desktop/download` re-hashes the file before serving it and returns `409`
  instead of sending bytes that no longer match;
- an unsigned or test-signed build is labelled `unsigned` / `self-signed`; nothing
  on the site calls it “firmado”;
- the official installer is hosted on the tag's GitHub Release and the committed
  `desktop.json` carries its `url`, so `/api/desktop/download` redirects instead
  of shipping tens of megabytes through the repository;
- binaries, `.sha256` files and `desktop-dev.json` are gitignored, so a local
  development build can be served without ever being committable.

Replacing a build means rebuilding — the version, checksum, channel and date in
the manifest change together with the file.
