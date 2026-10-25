import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import path from "node:path"

// ---------------------------------------------------------------------------
// Desktop Agent releases.
//
// Two channels, two pairs of files, and no guessing:
//
//   production   desktop.json       + ParadoxSetup.exe       official release
//   development  desktop-dev.json   + ParadoxSetup-dev.exe   test build
//
// The download route never points at a guessed file name: it reads the manifest
// for the configured channel and only offers an installer that is actually
// present, whose SHA-256 matches, and whose signature state the manifest does
// not overstate. Until that is true, the web shows an honest state instead of a
// dead or misleading button.
//
// The channel the deployment presents is `PARADOX_DESKTOP_CHANNEL`; it defaults
// to production, so a deployment that never sets it can only ever offer an
// authorized release, never the last development build.
// ---------------------------------------------------------------------------

/** Authenticode state of the published installer. */
export type DesktopSignatureStatus = "unsigned" | "self-signed" | "verified"

export type DesktopSignature = {
  status: DesktopSignatureStatus
  subject?: string
  thumbprint?: string
  timestamped?: boolean
  windowsStatus?: string
}

export type DesktopChannel = "development" | "production"

export type DesktopRelease = {
  version: string
  file: string
  os: string
  architecture: string
  sha256: string
  bytes: number
  releasedAt: string
  minimumAppVersion?: string
  channel: DesktopChannel
  // True when the file carries any signature; `signature.status` says whether
  // Windows trusts it. A development build may be signed with a test
  // certificate and is still never presented as a release.
  signed: boolean
  signature: DesktopSignature
  /** External download location, when the installer is not served locally. */
  url?: string
  notes?: string
}

/** Everything the UI and the route need to tell the truth about one channel. */
export type DesktopReleaseStatus =
  | { state: "available"; channel: DesktopChannel; release: DesktopRelease }
  | { state: "missing"; channel: DesktopChannel; message: string }
  | { state: "invalid"; channel: DesktopChannel; message: string }
  | {
      state: "artifact-missing"
      channel: DesktopChannel
      message: string
      release: DesktopRelease
    }
  | {
      state: "hash-mismatch"
      channel: DesktopChannel
      message: string
      release: DesktopRelease
      expected: string
      actual: string
    }

const DOWNLOADS_DIR = path.join(process.cwd(), "public", "downloads")

const MANIFESTS: Record<DesktopChannel, string> = {
  production: "desktop.json",
  development: "desktop-dev.json",
}

const INSTALLERS: Record<DesktopChannel, string> = {
  production: "ParadoxSetup.exe",
  development: "ParadoxSetup-dev.exe",
}

export const CHANNEL_LABELS: Record<DesktopChannel, string> = {
  production: "Producción",
  development: "Desarrollo",
}

const CHANNEL_VALUES: Record<string, DesktopChannel> = {
  dev: "development",
  development: "development",
  release: "production",
  production: "production",
}

// The deployment's own setting is forgiving: anything unexpected means
// production, the safer channel. A manifest, by contrast, must name a known
// channel (see parseDesktopManifest).
function parseChannel(value: string | undefined): DesktopChannel {
  return CHANNEL_VALUES[(value ?? "").trim().toLowerCase()] ?? "production"
}

/** The channel this deployment presents. Production unless told otherwise. */
export function desktopChannel(): DesktopChannel {
  return parseChannel(process.env.PARADOX_DESKTOP_CHANNEL)
}

export function manifestPath(channel: DesktopChannel) {
  return path.join(DOWNLOADS_DIR, MANIFESTS[channel])
}

export function installerPath(file: string) {
  return path.join(DOWNLOADS_DIR, file)
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
}

/** A manifest can never point outside the downloads directory. */
function isPlainFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 120 &&
    !value.includes("..") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value === path.basename(value)
  )
}

function readSignature(value: unknown, signed: unknown): DesktopSignature {
  if (value && typeof value === "object") {
    const declared = value as Record<string, unknown>
    const status =
      declared.status === "verified" || declared.status === "self-signed"
        ? declared.status
        : "unsigned"
    return {
      status,
      ...(typeof declared.subject === "string" ? { subject: declared.subject } : {}),
      ...(typeof declared.thumbprint === "string"
        ? { thumbprint: declared.thumbprint }
        : {}),
      ...(declared.timestamped === true ? { timestamped: true } : {}),
      ...(typeof declared.windowsStatus === "string"
        ? { windowsStatus: declared.windowsStatus }
        : {}),
    }
  }

  // Older manifests only said `signed: true`, which never proved a trusted
  // signature: it is read as "signed but not verified".
  return { status: signed === true ? "self-signed" : "unsigned" }
}

/**
 * Reads one manifest for the channel it is expected to belong to.
 *
 * Exported because this is the rule that decides whether a file may be offered
 * at all; the tests exercise it without touching the filesystem.
 */
export function parseDesktopManifest(
  raw: unknown,
  expected: DesktopChannel
): { ok: true; release: DesktopRelease } | { ok: false; message: string } {
  // These messages reach the page, so they are written for the person reading
  // it, not for a log.
  if (!raw || typeof raw !== "object") {
    return { ok: false, message: "el manifiesto no es un objeto JSON" }
  }
  const value = raw as Record<string, unknown>

  if (typeof value.version !== "string" || !value.version.trim()) {
    return { ok: false, message: "el manifiesto no indica ninguna versión" }
  }
  if (!isPlainFileName(value.file)) {
    return { ok: false, message: "el manifiesto nombra un archivo que no es válido" }
  }
  if (!isSha256(value.sha256)) {
    return { ok: false, message: "el manifiesto no tiene un SHA-256 válido" }
  }
  if (typeof value.bytes !== "number" || value.bytes <= 0) {
    return { ok: false, message: "el manifiesto no tiene un tamaño válido" }
  }
  if (typeof value.releasedAt !== "string") {
    return { ok: false, message: "el manifiesto no tiene fecha de publicación" }
  }

  // Older manifests predate channels; they were all development builds. A
  // channel name that is not one of ours is an invalid manifest, not a guess.
  let declared: DesktopChannel = "development"
  if (typeof value.channel === "string") {
    const mapped = CHANNEL_VALUES[value.channel.trim().toLowerCase()]
    if (!mapped) {
      return {
        ok: false,
        message: `el manifiesto declara un canal desconocido: "${value.channel}"`,
      }
    }
    declared = mapped
  }
  if (declared !== expected) {
    return {
      ok: false,
      message: `el manifiesto es de canal ${declared}, no una release de ${expected}`,
    }
  }

  if (value.file !== INSTALLERS[expected]) {
    return {
      ok: false,
      message: `el manifiesto nombra ${value.file} en lugar de ${INSTALLERS[expected]}`,
    }
  }

  const signature = readSignature(value.signature, value.signed)
  if (expected === "production" && signature.status !== "verified") {
    return {
      ok: false,
      message:
        "el manifiesto oficial no está respaldado por una firma de confianza verificada, así que no se ofrece como release",
    }
  }

  let url: string | undefined
  if (value.url !== undefined) {
    if (typeof value.url !== "string" || !/^https:\/\//i.test(value.url)) {
      return { ok: false, message: "la URL de descarga del manifiesto no es https" }
    }
    url = value.url
  }

  const release: DesktopRelease = {
    version: value.version.trim(),
    file: value.file,
    os: typeof value.os === "string" ? value.os : "Windows 10/11",
    architecture: typeof value.architecture === "string" ? value.architecture : "x64",
    sha256: value.sha256.toLowerCase(),
    bytes: value.bytes,
    releasedAt: value.releasedAt,
    ...(typeof value.minimumAppVersion === "string"
      ? { minimumAppVersion: value.minimumAppVersion }
      : {}),
    channel: expected,
    signed: signature.status !== "unsigned",
    signature,
    ...(url ? { url } : {}),
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
  }

  return { ok: true, release }
}

async function exists(file: string) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/** Reads one channel's manifest and checks it against the files on disk. */
export async function getDesktopReleaseStatus(
  channel: DesktopChannel = desktopChannel()
): Promise<DesktopReleaseStatus> {
  const manifest = manifestPath(channel)

  let text: string
  try {
    text = await readFile(manifest, "utf8")
  } catch {
    return {
      state: "missing",
      channel,
      message:
        channel === "production"
          ? "Todavía no hay una release oficial publicada."
          : "Todavía no hay una build de desarrollo publicada.",
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {
      state: "invalid",
      channel,
      message: "El manifiesto de la release no es JSON válido.",
    }
  }

  const parsed = parseDesktopManifest(raw, channel)
  if (!parsed.ok) {
    return { state: "invalid", channel, message: parsed.message }
  }

  const release = parsed.release
  if (release.url) return { state: "available", channel, release }

  if (!(await exists(installerPath(release.file)))) {
    return {
      state: "artifact-missing",
      channel,
      message:
        "El manifiesto existe, pero el instalador que nombra no está en este despliegue.",
      release,
    }
  }

  return { state: "available", channel, release }
}

// The hash of a large installer is computed once per file version, not once per
// request: the cache key includes size and mtime, so a replaced file is re-hashed.
const hashed = new Map<string, { key: string; sha256: string }>()

async function sha256Of(file: string): Promise<string> {
  const info = await stat(file)
  const key = `${info.size}:${info.mtimeMs}`
  const cached = hashed.get(file)
  if (cached?.key === key) return cached.sha256

  const digest = await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256")
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")))
  })

  hashed.set(file, { key, sha256: digest })
  return digest
}

export type ArtifactCheck =
  | { ok: true }
  | { ok: false; expected: string; actual: string }

/**
 * Re-checks the bytes of the published installer against the manifest before it
 * is served. A file that was replaced without republishing is refused, not sent
 * with a stale checksum.
 */
export async function verifyReleaseArtifact(
  release: DesktopRelease
): Promise<ArtifactCheck> {
  const actual = await sha256Of(installerPath(release.file))
  return actual === release.sha256
    ? { ok: true }
    : { ok: false, expected: release.sha256, actual }
}

/** Convenience for pages: the release when it can be offered, otherwise null. */
export async function getDesktopRelease(
  channel: DesktopChannel = desktopChannel()
): Promise<DesktopRelease | null> {
  const status = await getDesktopReleaseStatus(channel)
  return status.state === "available" ? status.release : null
}

/**
 * Resolves the `?channel=` parameter of the download route.
 *
 * No parameter means "the channel this deployment presents" — so a plain call
 * to `/api/desktop/download` can never change meaning. An explicit, known name
 * selects that channel (still subject to every manifest and hash check); an
 * unknown name resolves to null so the route can reject it instead of guessing.
 */
export function resolveRequestedChannel(
  param: string | null
): DesktopChannel | null {
  const value = (param ?? "").trim().toLowerCase()
  if (!value) return desktopChannel()
  return CHANNEL_VALUES[value] ?? null
}

export type OfferableDownload = {
  /** Status of this deployment's own channel: drives the empty-state message. */
  primary: DesktopReleaseStatus
  /** What the button can offer right now, and where it must point. */
  offer: { release: DesktopRelease; href: string } | null
}

/**
 * Pure decision behind the download button, so the rules are testable without
 * touching the filesystem:
 *
 *   - the deployment's own channel wins whenever it has a build;
 *   - otherwise, a valid development build still on disk may be offered — but
 *     only through an explicit `?channel=development` link, never by changing
 *     what the plain route serves. The UI labels it as a development build, so
 *     it can never pass as the official release.
 *
 * When nothing validates, there is no offer at all: no button, no guess.
 */
export function decideOffer(
  primary: DesktopReleaseStatus,
  development: DesktopReleaseStatus
): { release: DesktopRelease; href: string } | null {
  if (primary.state === "available") {
    return { release: primary.release, href: "/api/desktop/download" }
  }
  if (
    primary.channel !== "development" &&
    development.state === "available"
  ) {
    return {
      release: development.release,
      href: "/api/desktop/download?channel=development",
    }
  }
  return null
}

/** Reads both channels once and decides what this deployment can offer. */
export async function getOfferableDownload(): Promise<OfferableDownload> {
  const channel = desktopChannel()
  const primary = await getDesktopReleaseStatus(channel)
  const development =
    channel === "development"
      ? primary
      : await getDesktopReleaseStatus("development")
  return { primary, offer: decideOffer(primary, development) }
}
