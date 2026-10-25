import * as Sentry from "@sentry/nextjs"
import { auth } from "@clerk/nextjs/server"
import { NotFoundError } from "@browserbasehq/sdk"

import { browserbaseClient } from "@/lib/browserbase"
import { PAYWALL_ENABLED } from "@/lib/billing"

// Proxies a Browserbase session's replay so the browser can play it back. The
// retrieval needs the secret API key, so it can only happen server-side — the
// client never sees it, only the resulting HLS playlist.
//
// The recording isn't ready the instant the session closes; Browserbase reports
// it as not-yet-available for a short window afterwards. We pass that through as
// 202 Accepted so the SessionReplay component knows to keep polling, and hand
// back the `.m3u8` playlist with 200 once it exists.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { userId, has } = await auth()
  if (!userId) {
    return new Response("Unauthorized", { status: 401 })
  }

  const { sessionId } = await params

  Sentry.getIsolationScope().setAttributes({
    route: "GET /api/replays/[sessionId]",
    userId,
    sessionId,
  })

  // Session replay sits behind the paid plan. Gate it here, not just in the UI,
  // so a free account can't pull a recording by calling the route directly.
  // `bots` is the plan's feature slug in Clerk Billing.
  // (test version: the paywall is off entirely, so replays are open)
  if (PAYWALL_ENABLED && !has({ feature: "bots" })) {
    Sentry.logger.warn("Session replay denied — paid plan required", {
      userId,
      sessionId,
    })
    return new Response("Paid plan required", { status: 403 })
  }

  try {
    // Page metadata for the replay: one entry per page the session visited, each
    // with its own HLS playlist. While the recording is still processing this
    // comes back with no pages — treat that as not-ready.
    const replay = await browserbaseClient().sessions.replays.retrieve(sessionId)
    const firstPage = replay.pages[0]
    if (!firstPage) {
      return new Response(null, { status: 202 })
    }

    // The playlist itself. Its segment URLs are pre-signed CDN links, so only
    // this manifest needs proxying — hls.js fetches the segments directly.
    const playlist = await browserbaseClient().sessions.replays.retrievePage(
      sessionId,
      firstPage.pageId
    )
    const m3u8 = await playlist.text()

    Sentry.logger.info("Session replay served", {
      sessionId,
      userId,
      pageCount: replay.pages.length,
    })

    return new Response(m3u8, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        // The playlist's pre-signed segment URLs rotate, so don't let a stale
        // manifest be cached.
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    // Before the replay is registered, Browserbase 404s the resource. That's the
    // not-ready window, not a real miss — surface it as 202 so the client polls.
    if (error instanceof NotFoundError) {
      return new Response(null, { status: 202 })
    }
    throw error
  }
}
