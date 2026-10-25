import { auth } from "@clerk/nextjs/server"

import { getLiveFeed } from "@/queries/live"

// Live View polls this while it is open. It must never be cached by the browser
// or a proxy: the answer is one person's tasks, and it changes by the second.
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
    const feed = await getLiveFeed(userId)
    return Response.json(
      { ok: true, feed },
      { headers: { "cache-control": "no-store" } }
    )
  } catch (error) {
    // The panel shows a recoverable message; the database error itself is not
    // sent to the browser.
    console.error("[live] feed failed", error)
    return Response.json(
      { ok: false, error: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } }
    )
  }
}
