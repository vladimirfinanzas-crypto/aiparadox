import { and, eq } from "drizzle-orm"

import { db } from "@/db"
import { integrations, pcJobs, type PcAction } from "@/db/schema"
import {
  hasPausedDevice,
  isDeviceOnline,
  listDevices,
} from "@/lib/desktop-devices"

// The computer agent's job queue. Everything here runs inside the Trigger.dev
// chat task, so a long wait is fine — the task is durable and can sleep.

const POLL_MS = 750
// How long a queued action waits for someone to claim it before the answer
// becomes "there is no computer reachable", rather than "still working"
const UNCLAIMED_MS = 15_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const INSTALL_HINT =
  "The person has to install Paradox Desktop Agent on the computer you should control: Settings → Desktop Agent (in the app, /settings/desktop-agent). Once it is running and its device is online, try again."

// The integration row for this person, created on demand. Kept because tokens
// issued before device enrollment still authenticate the machine that has one.
export async function getOrCreateIntegration(userId: string) {
  const existing = await db.query.integrations.findFirst({
    where: eq(integrations.userId, userId),
  })
  if (existing) return existing

  const [created] = await db
    .insert(integrations)
    .values({ userId })
    .returning()
  return created
}

// What the person needs to know to connect a computer. The current path is the
// installer and its enrollment code; the legacy Python token stays documented
// for a machine that already runs the old agent.
export async function pcAgentSetup(userId: string) {
  const integration = await getOrCreateIntegration(userId)
  const devices = await listDevices(userId)
  const online = devices.filter(
    (device) => device.status === "online" && isDeviceOnline(device)
  )

  return {
    // Legacy token, only meaningful to the pre-installer agent
    token: integration.pcAgentToken ?? "",
    status: integration.pcAgentStatus,
    command: "python pc-agent/agent.py --api <APP_URL>",
    // Device enrollment (the supported path)
    installPath: "/settings/desktop-agent",
    downloadPath: "/download/desktop",
    devices: devices.map((device) => ({
      id: device.id,
      name: device.name,
      os: device.os,
      status: device.status,
      online: device.status === "online" && isDeviceOnline(device),
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    })),
    onlineDevices: online.length,
  }
}

// Queues one desktop action for the person's own computer. When `deviceId` is
// given the job is addressed to that machine only: a task that opened its
// browser window on one computer never continues on another.
export async function enqueuePcJob(
  userId: string,
  action: PcAction,
  deviceId?: string
) {
  const [job] = await db
    .insert(pcJobs)
    .values({ userId, action, ...(deviceId ? { deviceId } : {}) })
    .returning({ id: pcJobs.id })

  return job.id
}

// Whether the person has any computer listening right now. With a `deviceId`
// the question is about that exact machine.
export async function isPcAgentOnline(userId: string, deviceId?: string) {
  const devices = await listDevices(userId)
  if (
    devices.some(
      (device) =>
        device.status === "online" &&
        isDeviceOnline(device) &&
        (!deviceId || device.id === deviceId)
    )
  ) {
    return true
  }

  // A job addressed to one machine cannot run on the legacy token
  if (deviceId) return false

  const integration = await db.query.integrations.findFirst({
    where: and(
      eq(integrations.userId, userId),
      eq(integrations.pcAgentStatus, "online")
    ),
  })
  return !!integration
}

// Runs one desktop action and waits for the local agent to finish it. Throws a
// message the model can act on when there is no computer listening.
export async function runPcAction(
  userId: string,
  action: PcAction,
  { timeoutMs = 120_000, deviceId }: { timeoutMs?: number; deviceId?: string } = {}
) {
  if (!(await isPcAgentOnline(userId, deviceId))) {
    if (await hasPausedDevice(userId)) {
      throw new Error(
        "The person paused their Desktop Agent, so no local action can run until they resume it in Settings → Desktop Agent."
      )
    }
    throw new Error(
      deviceId
        ? "The computer this task was using went offline. Reconnect Paradox Desktop Agent, or ask the person to choose an environment again."
        : `No computer is connected to this account. ${INSTALL_HINT}`
    )
  }

  const jobId = await enqueuePcJob(userId, action, deviceId)

  const startedAt = Date.now()
  let job: typeof pcJobs.$inferSelect | undefined

  while (Date.now() - startedAt < timeoutMs) {
    ;[job] = await db.select().from(pcJobs).where(eq(pcJobs.id, jobId))

    if (job?.status === "done") return job.result ?? { ok: true }
    if (job?.status === "failed") {
      throw new Error(job.error ?? "The computer agent failed that action.")
    }

    if (Date.now() - startedAt > UNCLAIMED_MS && job?.status === "pending") {
      throw new Error(
        "The computer did not pick up the action. It may have gone offline or the agent may not be running. " +
          INSTALL_HINT
      )
    }

    await sleep(POLL_MS)
  }

  throw new Error("The computer took too long to answer that action.")
}
