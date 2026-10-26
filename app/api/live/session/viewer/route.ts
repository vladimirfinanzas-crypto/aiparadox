import { auth } from "@clerk/nextjs/server"
import { NotFoundError } from "@browserbasehq/sdk"
import * as Sentry from "@sentry/nextjs"

import { browserbaseClient } from "@/lib/browserbase"
import { getExecutionTask } from "@/lib/execution-tasks"

// Browserbase's own live view for a session that is still running.
//
// Why a link and not our own video: the browser runs on Browserbase's machines
// and they own the stream; `sessions.debug` is their supported way to watch it
// (SDK: sessions.debug(id, { expiresIn }) → debuggerUrl). We do not build a
// second, worse viewer on top of a private CDP socket.
//
// The URL is short-lived and only ever handed to the person whose task opened
// the session. The session id is never read from the browser: the caller names
// the task, the server resolves it against their own rows, so editing a query
// string cannot reach another account's session.

/** Ten minutes: long enough to open a tab, short enough to expire quietly. */
const VIEWER_TTL_SECONDS = 600

export const dynamic = "force-dynamic"

function noStore(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  })
}

export async function GET(request: Request) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return noStore({ ok: false, error: "unauthorized" }, 401)
  }

  const taskId = new URL(request.url).searchParams.get("taskId")?.trim()
  if (!taskId) {
    return noStore({ ok: false, error: "missing_task" }, 400)
  }

  // Ownership is checked against the task row, never against anything the
  // request claims, and answered as "not found" so this route cannot be used to
  // probe which task ids exist in another account.
  const task = await getExecutionTask(taskId, userId)
  if (!task) return noStore({ ok: false, error: "not_found" }, 404)

  if (task.environment !== "cloud") {
    return noStore({ ok: false, error: "not_cloud" }, 409)
  }
  if (!task.browserSessionId) {
    // The task chose the cloud but no browser has been opened yet.
    return noStore({ ok: false, error: "no_session" }, 409)
  }

  Sentry.getIsolationScope().setAttributes({
    route: "GET /api/live/session/viewer",
    userId,
    "browser.sessionId": task.browserSessionId,
  })

  try {
    const live = await browserbaseClient().sessions.debug(task.browserSessionId, {
      expiresIn: VIEWER_TTL_SECONDS,
    })

    return noStore({
      ok: true,
      url: live.debuggerUrl,
      fullscreenUrl: live.debuggerFullscreenUrl,
      expiresInSeconds: VIEWER_TTL_SECONDS,
      // The tabs the session has open right now, each with its own viewer link.
      pages: (live.pages ?? []).map((page) => ({
        title: page.title,
        url: page.url,
        debuggerUrl: page.debuggerUrl,
        faviconUrl: page.faviconUrl,
      })),
    })
  } catch (error) {
    // The session ended between the poll and this click: Browserbase 404s it.
    // That is not an outage, and the panel should offer the recording instead.
    if (error instanceof NotFoundError) {
      Sentry.logger.info("Live viewer requested for a session that ended", {
        userId,
        "browser.sessionId": task.browserSessionId,
      })
      return noStore({ ok: false, error: "session_ended" }, 410)
    }

    const message = error instanceof Error ? error.message : "unknown"
    Sentry.logger.warn("Live viewer failed", {
      userId,
      "browser.sessionId": task.browserSessionId,
      error: message,
    })
    return noStore({ ok: false, error: "provider_error" }, 502)
  }
}
