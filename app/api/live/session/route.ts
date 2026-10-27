import { auth } from "@clerk/nextjs/server"

import { getLiveSession } from "@/queries/live"

// The session behind the feed. Live View polls this while the panel is open, so
// it must never be cached by the browser or a proxy: it is one person's session.
export const dynamic = "force-dynamic"

export async function GET() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return Response.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } }
    )
  }

  try {
    const session = await getLiveSession(userId)
    return Response.json(
      { ok: true, session },
      { headers: { "cache-control": "no-store" } }
    )
  } catch (error) {
    console.error("[live] session failed", error)
    return Response.json(
      { ok: false, error: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } }
    )
  }
}
