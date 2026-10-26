import { createEnrollment } from "@/lib/desktop-devices"
import { createThrottle } from "@/lib/throttle"

// The local agent's first call: ask for a short code it can show the person.
// Nothing is authorized by this call — the code only becomes a device once a
// signed-in person approves it in the web app.
//
//   POST /api/desktop/enrollments { deviceName, os }
//     -> { code, expiresAt, approvalPath }
//
// A tiny in-process throttle keeps one client from minting codes in a loop.
// Bounded on purpose: an unbounded Map keyed by client address is a leak on a
// long-running server, and this endpoint is the one an anonymous caller can hit.
const throttle = createThrottle({ windowMs: 5_000, maxEntries: 5_000 })

function clientKey(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "local"
  )
}

export async function POST(request: Request) {
  if (!throttle.allow(clientKey(request))) {
    return Response.json(
      { error: "Wait a few seconds before requesting another code." },
      { status: 429 }
    )
  }

  let body: { deviceName?: string; os?: string } = {}
  try {
    body = await request.json()
  } catch {
    // An empty body is fine: the agent may not know its own name yet
  }

  const { code, expiresAt } = await createEnrollment({
    deviceName: typeof body.deviceName === "string" ? body.deviceName : undefined,
    os: typeof body.os === "string" ? body.os : undefined,
  })

  return Response.json({
    code,
    expiresAt: expiresAt.toISOString(),
    approvalPath: `/settings/desktop-agent?code=${code}`,
  })
}
