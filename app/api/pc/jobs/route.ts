import { and, eq, isNull, or } from "drizzle-orm"

import { db } from "@/db"
import { pcJobs, type PcAction } from "@/db/schema"
import { authenticateAgent, recordDeviceCapabilities } from "@/lib/desktop-devices"

// What the local Desktop Agent calls. It authenticates with the token it got
// when its device was enrolled; that token maps to exactly one person's
// computer and one person's job queue — it can never see another account's
// jobs. Tokens minted before devices existed still work.
//
//   GET  /api/pc/jobs   -> the next pending job, claimed (204 when idle)
//   POST /api/pc/jobs   -> the result of a job it finished
//
// The agent polls instead of listening, so it needs no open port and no
// inbound path to the person's machine.

// The local agent asks for work. 204 when there is nothing to do, so it can go
// back to sleep without treating an empty queue as an error.
export async function GET(request: Request) {
  const agent = await authenticateAgent(request)
  if (!agent) return new Response("Unauthorized", { status: 401 })

  // A paused device stays connected and visible but is handed nothing.
  if (agent.paused) return Response.json({ status: "paused" }, { status: 403 })

  if (agent.deviceId) {
    const capabilities = (request.headers.get("x-agent-capabilities") ?? "")
      .split(",")
      .map((capability) => capability.trim())
      .filter(Boolean)
    if (capabilities.length > 0) {
      await recordDeviceCapabilities(agent.deviceId, capabilities)
    }
  }

  // A job addressed to one machine is only visible to that machine; a job with
  // no address can be claimed by any of the person's computers (the legacy
  // behaviour, kept so older agents keep working).
  const scope = agent.deviceId
    ? and(
        eq(pcJobs.userId, agent.userId),
        eq(pcJobs.status, "pending"),
        or(eq(pcJobs.deviceId, agent.deviceId), isNull(pcJobs.deviceId))
      )
    : and(eq(pcJobs.userId, agent.userId), eq(pcJobs.status, "pending"))

  // Oldest waiting job first, then claim it. The status is re-checked in the
  // update so two polls racing each other can never both take the same job.
  const [next] = await db
    .select({ id: pcJobs.id })
    .from(pcJobs)
    .where(scope)
    .orderBy(pcJobs.createdAt)
    .limit(1)

  if (!next) return new Response(null, { status: 204 })

  const [job] = await db
    .update(pcJobs)
    .set({ status: "claimed", claimedAt: new Date() })
    .where(and(eq(pcJobs.id, next.id), eq(pcJobs.status, "pending")))
    .returning()

  if (!job) return new Response(null, { status: 204 })

  return Response.json({ id: job.id, action: job.action satisfies PcAction })
}

// The local agent reports what happened
export async function POST(request: Request) {
  const agent = await authenticateAgent(request)
  if (!agent) return new Response("Unauthorized", { status: 401 })

  let body: { id?: string; ok?: boolean; result?: unknown; error?: string }
  try {
    body = await request.json()
  } catch {
    return new Response("Invalid JSON body", { status: 400 })
  }

  if (!body.id || typeof body.id !== "string") {
    return new Response("Expected { id }", { status: 400 })
  }

  // Scoped by owner, so an id from another account never matches
  const [updated] = await db
    .update(pcJobs)
    .set({
      status: body.ok === false ? "failed" : "done",
      result: body.ok === false ? null : (body.result ?? { ok: true }),
      error: body.ok === false ? (body.error ?? "The action failed.") : null,
      completedAt: new Date(),
    })
    .where(and(eq(pcJobs.id, body.id), eq(pcJobs.userId, agent.userId)))
    .returning({ id: pcJobs.id })

  if (!updated) return new Response("Job not found", { status: 404 })

  return Response.json({ ok: true })
}
