import { createReadStream } from "node:fs"
import { Readable } from "node:stream"

import {
  getDesktopReleaseStatus,
  installerPath,
  resolveRequestedChannel,
  verifyReleaseArtifact,
} from "@/lib/desktop-release"

// One permanent URL for the installer of the channel this deployment presents
// (PARADOX_DESKTOP_CHANNEL, production by default). `?channel=development` (or
// `?channel=production`) asks for the other channel by name — an unknown name
// is a 400, never a guess — and the selected channel goes through exactly the
// same manifest, artifact and hash checks as the default one.
//
// It serves only a build the manifest backs:
//   - no manifest: 404, nothing to offer;
//   - manifest invalid, or a development build offered as production: 422;
//   - manifest names a file this deployment does not have: 410;
//   - the file's SHA-256 no longer matches: 409, and nothing is sent;
//   - an external https download URL: 302 to it;
//   - otherwise: the file, with its checksum and signature state in headers.
//
// The signature itself is read on the machine that signed the build, not here:
// the route reports what the manifest records and never upgrades that to
// "verified" on its own.
export async function GET(request: Request) {
  const channel = resolveRequestedChannel(
    new URL(request.url).searchParams.get("channel")
  )

  if (!channel) {
    return Response.json(
      {
        error: "Canal de descarga desconocido.",
        hint: "Usa ?channel=development o ?channel=production, o no pongas ningún parámetro.",
      },
      { status: 400, headers: { "cache-control": "no-store" } }
    )
  }

  const status = await getDesktopReleaseStatus(channel)

  if (status.state === "missing") {
    return Response.json(
      {
        error: status.message,
        channel: status.channel,
        hint:
          status.channel === "production"
            ? "Una release oficial se publica con `python desktop/package.py --channel production --publish`."
            : "Una build de desarrollo se genera con `python desktop/package.py --channel development`.",
      },
      { status: 404, headers: { "cache-control": "no-store" } }
    )
  }

  if (status.state === "invalid") {
    return Response.json(
      {
        error: status.message,
        channel: status.channel,
        hint: "El manifiesto no se anuncia hasta que describa un artefacto que este despliegue pueda servir.",
      },
      { status: 422, headers: { "cache-control": "no-store" } }
    )
  }

  if (status.state === "artifact-missing") {
    return Response.json(
      {
        error: status.message,
        channel: status.channel,
        version: status.release.version,
        hint: "El despliegue tiene que incluir el instalador que el manifiesto nombra.",
      },
      { status: 410, headers: { "cache-control": "no-store" } }
    )
  }

  const release = status.release

  // An external host (a GitHub Release, a CDN) is allowed to serve the file;
  // the checksum is still the one the manifest published.
  if (release.url) {
    return new Response(null, {
      status: 302,
      headers: {
        location: release.url,
        "x-release-version": release.version,
        "x-release-channel": release.channel,
        "x-release-signature": release.signature.status,
        "x-checksum-sha256": release.sha256,
        "cache-control": "no-store",
      },
    })
  }

  const check = await verifyReleaseArtifact(release)
  if (!check.ok) {
    return Response.json(
      {
        error:
          "El instalador publicado no coincide con el SHA-256 de su manifiesto, así que no se sirve.",
        channel: release.channel,
        expected: check.expected,
        actual: check.actual,
      },
      { status: 409, headers: { "cache-control": "no-store" } }
    )
  }

  const stream = Readable.toWeb(
    createReadStream(installerPath(release.file))
  ) as ReadableStream

  return new Response(stream, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(release.bytes),
      "content-disposition": `attachment; filename="${release.file}"`,
      // Lets a client (and the agent's updater) check what it downloaded
      "x-checksum-sha256": release.sha256,
      "x-release-version": release.version,
      "x-release-channel": release.channel,
      "x-release-signature": release.signature.status,
      "cache-control": "public, max-age=300",
    },
  })
}
