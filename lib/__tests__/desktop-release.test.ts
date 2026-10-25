import { describe, expect, it } from "vitest"

import {
  decideOffer,
  desktopChannel,
  parseDesktopManifest,
  resolveRequestedChannel,
  type DesktopRelease,
  type DesktopReleaseStatus,
} from "@/lib/desktop-release"

const SHA = "a".repeat(64)

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    product: "Paradox Desktop Agent",
    version: "1.2.0",
    file: "ParadoxSetup-dev.exe",
    os: "Windows 10/11",
    architecture: "x64",
    sha256: SHA,
    bytes: 26_000_000,
    releasedAt: "2026-10-23T10:00:00.000Z",
    channel: "development",
    signed: false,
    signature: { status: "unsigned" },
    ...overrides,
  }
}

describe("development manifests", () => {
  it("accepts an unsigned development build", () => {
    const parsed = parseDesktopManifest(manifest(), "development")
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.release.channel).toBe("development")
    expect(parsed.release.signed).toBe(false)
    expect(parsed.release.signature.status).toBe("unsigned")
  })

  it("records a test signature honestly without calling it verified", () => {
    const parsed = parseDesktopManifest(
      manifest({
        signed: true,
        signature: {
          status: "self-signed",
          subject: "CN=Paradox Desktop Agent (Development), O=Paradox",
        },
      }),
      "development"
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.release.signature.status).toBe("self-signed")
    expect(parsed.release.signed).toBe(true)
  })

  it("never turns a legacy `signed: true` into a verified signature", () => {
    // A manifest written before channels existed has no `channel` field and only
    // `signed: true`; it can only have been a development build.
    const legacy = manifest({
      channel: undefined,
      signed: true,
      signature: undefined,
    })
    const parsed = parseDesktopManifest(legacy, "development")
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.release.channel).toBe("development")
    expect(parsed.release.signature.status).toBe("self-signed")
  })

  it("refuses a legacy manifest that names the official installer", () => {
    // Older dev builds were also called ParadoxSetup.exe. Without a channel the
    // file name is the only evidence, and it points at the official slot: the
    // manifest is not attributed to development by guesswork.
    const legacy = manifest({ channel: undefined, file: "ParadoxSetup.exe" })
    expect(parseDesktopManifest(legacy, "development").ok).toBe(false)
  })
})

describe("the official channel", () => {
  it("refuses a development build", () => {
    const parsed = parseDesktopManifest(manifest(), "production")
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain("no una release de production")
  })

  it("refuses an unsigned production manifest", () => {
    const parsed = parseDesktopManifest(
      manifest({
        channel: "production",
        file: "ParadoxSetup.exe",
        signature: { status: "unsigned" },
      }),
      "production"
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain("firma de confianza")
  })

  it("accepts a verified production release", () => {
    const parsed = parseDesktopManifest(
      manifest({
        channel: "production",
        file: "ParadoxSetup.exe",
        signed: true,
        signature: {
          status: "verified",
          subject: "CN=Paradox Technologies SL, O=Paradox Technologies SL",
        },
      }),
      "production"
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.release.channel).toBe("production")
    expect(parsed.release.signature.status).toBe("verified")
  })

  it("accepts the old `release` spelling for the channel", () => {
    const parsed = parseDesktopManifest(
      manifest({
        channel: "release",
        file: "ParadoxSetup.exe",
        signed: true,
        signature: { status: "verified", subject: "CN=Paradox SL" },
      }),
      "production"
    )
    expect(parsed.ok).toBe(true)
  })
})

describe("bad manifests", () => {
  it("rejects a checksum that is not a SHA-256", () => {
    const parsed = parseDesktopManifest(manifest({ sha256: "abc" }), "development")
    expect(parsed.ok).toBe(false)
  })

  it("rejects a file name that tries to escape the download folder", () => {
    for (const file of ["../setup.exe", "nested/setup.exe", "..\\setup.exe", ""]) {
      const parsed = parseDesktopManifest(manifest({ file }), "development")
      expect(parsed.ok, file).toBe(false)
    }
  })

  it("rejects a download URL that is not https", () => {
    const parsed = parseDesktopManifest(
      manifest({ url: "http://releases.midominio.com/setup.exe" }),
      "development"
    )
    expect(parsed.ok).toBe(false)
  })

  it("accepts an https external download URL", () => {
    const parsed = parseDesktopManifest(
      manifest({ url: "https://github.com/org/repo/releases/download/x/y.exe" }),
      "development"
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.release.url).toContain("https://")
  })

  it("rejects a manifest that is not an object or has no version", () => {
    expect(parseDesktopManifest(null, "development").ok).toBe(false)
    expect(parseDesktopManifest(manifest({ version: "" }), "development").ok).toBe(
      false
    )
  })

  it("rejects a size that cannot describe a file", () => {
    expect(parseDesktopManifest(manifest({ bytes: 0 }), "development").ok).toBe(false)
  })

  it("rejects an unknown channel instead of guessing one", () => {
    for (const channel of ["beta", "staging", "Dev-Latest", ""]) {
      const parsed = parseDesktopManifest(manifest({ channel }), "development")
      expect(parsed.ok, channel).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// What the download button is allowed to offer.
// ---------------------------------------------------------------------------

function release(channel: "development" | "production"): DesktopRelease {
  return {
    version: "1.2.0",
    file: channel === "development" ? "ParadoxSetup-dev.exe" : "ParadoxSetup.exe",
    os: "Windows 10/11",
    architecture: "x64",
    sha256: SHA,
    bytes: 26_000_000,
    releasedAt: "2026-10-23T10:00:00.000Z",
    channel,
    signed: channel === "production",
    signature:
      channel === "production"
        ? { status: "verified", subject: "CN=Paradox Technologies SL" }
        : { status: "unsigned" },
  }
}

const available = (
  channel: "development" | "production"
): DesktopReleaseStatus => ({
  state: "available",
  channel,
  release: release(channel),
})

const missing = (channel: "development" | "production"): DesktopReleaseStatus => ({
  state: "missing",
  channel,
  message: "nada publicado",
})

describe("decideOffer", () => {
  it("serves the deployment's own channel through the plain route", () => {
    const offer = decideOffer(available("production"), available("development"))
    expect(offer?.href).toBe("/api/desktop/download")
    expect(offer?.release.channel).toBe("production")
  })

  it("offers a leftover development build only through an explicit channel link", () => {
    const offer = decideOffer(missing("production"), available("development"))
    expect(offer?.href).toBe("/api/desktop/download?channel=development")
    expect(offer?.release.channel).toBe("development")
  })

  it("prefers the official release when both channels have a build", () => {
    const offer = decideOffer(available("production"), available("development"))
    expect(offer?.release.file).toBe("ParadoxSetup.exe")
  })

  it("never falls back when development is already the own channel", () => {
    // A development deployment that has nothing published offers nothing; the
    // fallback must not turn its own missing manifest into a second opinion.
    expect(decideOffer(missing("development"), missing("development"))).toBeNull()
    expect(decideOffer(missing("development"), available("development"))).toBeNull()
  })

  it("offers nothing when neither channel validates", () => {
    expect(decideOffer(missing("production"), missing("development"))).toBeNull()
    const invalid: DesktopReleaseStatus = {
      state: "invalid",
      channel: "development",
      message: "manifiesto roto",
    }
    expect(decideOffer(missing("production"), invalid)).toBeNull()
  })
})

describe("resolveRequestedChannel", () => {
  it("defaults to the deployment's own channel without a parameter", () => {
    expect(resolveRequestedChannel(null)).toBe(desktopChannel())
    expect(resolveRequestedChannel("")).toBe(desktopChannel())
    expect(resolveRequestedChannel("  ")).toBe(desktopChannel())
  })

  it("accepts the known names of both channels", () => {
    expect(resolveRequestedChannel("development")).toBe("development")
    expect(resolveRequestedChannel("dev")).toBe("development")
    expect(resolveRequestedChannel(" Development ")).toBe("development")
    expect(resolveRequestedChannel("production")).toBe("production")
    expect(resolveRequestedChannel("release")).toBe("production")
  })

  it("rejects unknown names instead of guessing a channel", () => {
    expect(resolveRequestedChannel("nightly")).toBeNull()
    expect(resolveRequestedChannel("prod")).toBeNull()
  })
})
