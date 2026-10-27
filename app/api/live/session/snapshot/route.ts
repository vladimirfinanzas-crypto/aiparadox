import { auth } from "@clerk/nextjs/server"
import * as Sentry from "@sentry/nextjs"
import { z } from "zod"

import { getExecutionTask } from "@/lib/execution-tasks"
import { runPcAction } from "@/lib/pc"

// One screenshot of the browser the Desktop Agent opened for a task.
//
// There is no live video of a local session and this route does not pretend
// otherwise: the Desktop Agent has no inbound connection (it polls a job queue
// over HTTPS), so a picture is fetched one job at a time and the panel shows it
// as an updated capture with its timestamp.
//
// Scope of what is captured: only the Paradox-controlled browser window of that
// task (`browser_screenshot` with the task's session key). The person's whole
// desktop is never requested from here — Live View is a view of the agent's
// work, not a way to look around someone's screen.
//
// Budget: one call must finish well inside a serverless function's limit. If the
// agent is slow or absent, the person gets a reason and a retry, not a hang.

const SNAPSHOT_BUDGET_MS = 8_000
// A browser-window PNG is usually well under this; a whole-desktop capture would
// blow past it, which is exactly why it is not requested.
const MAX_IMAGE_BYTES = 4_000_000

const bodySchema = z.object({ taskId: z.string().trim().min(1).max(200) })

export const dynamic = "force-dynamic"

function noStore(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  })
}

type SnapshotResult =
  | {
      ok: true
      base64: string
      mediaType: string
      url: string
      capturedAt: string
    }
  | { ok: false; error: string; message: string }

/** The agent's own failures, in words the person can act on. */
function failure(error: unknown): SnapshotResult {
  const message = error instanceof Error ? error.message : String(error)

  // Each pattern is the agent's own wording for one cause. They are evaluated
  // to booleans: `offline ? ...` would test the RegExp object itself, which is
  // always truthy, and every failure would be reported as an offline computer.
  const offline = /no computer is connected|went offline|did not pick up/i.test(message)
  const paused = /paused their Desktop Agent/i.test(message)
  const timeout = /took too long|no respondi\u00f3 a tiempo/i.test(message)
  const noBrowser = /no page|does not include the local browser engine|update Paradox Desktop Agent/i.test(
    message
  )

  return {
    ok: false,
    error: offline
      ? "device_offline"
      : paused
        ? "agent_paused"
        : timeout
          ? "timeout"
          : noBrowser
            ? "no_browser_session"
            : "failed",
    message,
  }
}

export async function POST(request: Request) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return noStore({ ok: false, error: "unauthorized" }, 401)
  }

  let parsed: ReturnType<typeof bodySchema.safeParse> | undefined
  try {
    parsed = bodySchema.safeParse(await request.json())
  } catch {
    return noStore({ ok: false, error: "invalid_body" }, 400)
  }
  if (!parsed?.success) return noStore({ ok: false, error: "invalid_body" }, 400)

  // Ownership, resolved against this person's own rows. A task id from another
  // account is simply not found.
  const task = await getExecutionTask(parsed.data.taskId, userId)
  if (!task) return noStore({ ok: false, error: "not_found" }, 404)

  if (task.environment !== "local") {
    return noStore({ ok: false, error: "not_local" }, 409)
  }

  Sentry.getIsolationScope().setAttributes({
    route: "POST /api/live/session/snapshot",
    userId,
    "execution.taskId": task.id,
  })

  const startedAt = Date.now()
  try {
    const result = (await runPcAction(
      userId,
      { kind: "browser_screenshot", sessionKey: task.id },
      { timeoutMs: SNAPSHOT_BUDGET_MS }
    )) as {
      image?: string
      url?: string
      width?: number
      height?: number
    }

    if (!result?.image) {
      Sentry.logger.warn("Live snapshot returned no image", {
        userId,
        "execution.taskId": task.id,
      })
      return noStore(failure(new Error("The agent returned an empty screenshot.")))
    }

    // The agent answers as a data URL; the length check catches a capture that
    // is far too big to poll for, instead of pushing it to the browser.
    if (result.image.length > MAX_IMAGE_BYTES) {
      return noStore({
        ok: false,
        error: "image_too_large",
        message:
          "La captura pesa demasiado para enviarse cada pocos segundos. Cierra pestañas o ventanas grandes en esa ventana del navegador.",
      })
    }

    const [header, base64 = ""] = result.image.split(",")
    const mediaType = header?.includes("jpeg") ? "image/jpeg" : "image/png"

    if (!base64) {
      return noStore(failure(new Error("The agent returned an empty screenshot.")))
    }

    Sentry.logger.info("Live snapshot served", {
      userId,
      "execution.taskId": task.id,
      "snapshot.ms": Date.now() - startedAt,
      "snapshot.bytes": base64.length,
    })

    return noStore({
      ok: true,
      base64,
      mediaType,
      url: result.url ?? "",
      capturedAt: new Date().toISOString(),
    })
  } catch (error) {
    Sentry.logger.info("Live snapshot not available", {
      userId,
      "execution.taskId": task.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return noStore(failure(error))
  }
}
