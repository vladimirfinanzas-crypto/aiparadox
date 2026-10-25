import { createHash, randomInt } from "node:crypto"

import { and, desc, eq, gt, isNull } from "drizzle-orm"
import { nanoid } from "nanoid"

import { db } from "@/db"
import {
  desktopDevices,
  desktopEnrollments,
  integrations,
  pcJobs,
  type DesktopDevice,
} from "@/db/schema"

// ---------------------------------------------------------------------------
// Desktop Agent devices.
//
// Linking is a device-authorization flow, not a shared secret copied out of a
// settings page: the local agent asks for a short code, the signed-in person
// approves it in the web app, and only then does the agent exchange that code
// for its own revocable token. Tokens are stored hashed, so a database read
// never yields a working credential.
// ---------------------------------------------------------------------------

// A device that has not polled in this long is shown as offline
const ONLINE_WINDOW_MS = 90_000
const ENROLLMENT_TTL_MS = 10 * 60_000

// No 0/O or 1/I: the code is read off a screen and typed by a person
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export function hashDeviceToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function newCode(length = 8) {
  let code = ""
  for (let index = 0; index < length; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  }
  return code
}

function newDeviceToken() {
  return `pd_${nanoid(40)}`
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

// The local agent calls this first. No session is needed: the code proves
// nothing until a signed-in person approves it.
export async function createEnrollment(input: {
  deviceName?: string
  os?: string
}) {
  const code = newCode()
  const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS)

  await db.insert(desktopEnrollments).values({
    code,
    deviceName: input.deviceName?.slice(0, 80) || "This computer",
    os: input.os?.slice(0, 80),
    expiresAt,
  })

  return { code, expiresAt }
}

export async function getEnrollment(code: string) {
  const [row] = await db
    .select()
    .from(desktopEnrollments)
    .where(eq(desktopEnrollments.code, code.trim().toUpperCase()))

  return row
}

// The signed-in person approves a code. The user id comes from the session
// here, never from the request body, so a code can only be bound to the
// account that approved it.
export async function approveEnrollment({
  code,
  userId,
}: {
  code: string
  userId: string
}) {
  const normalized = code.trim().toUpperCase()
  const enrollment = await getEnrollment(normalized)

  if (!enrollment) throw new Error("That code does not exist.")
  if (enrollment.status === "consumed") {
    throw new Error("That code was already used on a device.")
  }
  if (enrollment.expiresAt.getTime() < Date.now()) {
    throw new Error("That code expired. Ask the agent for a new one.")
  }

  const [approved] = await db
    .update(desktopEnrollments)
    .set({ userId, status: "approved", approvedAt: new Date() })
    .where(
      and(
        eq(desktopEnrollments.code, normalized),
        eq(desktopEnrollments.status, "pending")
      )
    )
    .returning()

  if (!approved) {
    // Already approved: approving twice is harmless and idempotent for the
    // same person, but never re-binds it to someone else.
    const current = await getEnrollment(normalized)
    if (current?.status === "approved" && current.userId === userId) {
      return current
    }
    throw new Error("That code is not waiting for approval.")
  }

  return approved
}

export async function cancelEnrollment(code: string) {
  await db
    .update(desktopEnrollments)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(desktopEnrollments.code, code.trim().toUpperCase()),
        eq(desktopEnrollments.status, "pending")
      )
    )
}

// The agent polls this until the code is approved, then receives its token —
// exactly once. The browser never sees it.
export async function redeemEnrollment(code: string) {
  const normalized = code.trim().toUpperCase()

  const [redeemed] = await db
    .update(desktopEnrollments)
    .set({ status: "consumed", consumedAt: new Date() })
    .where(
      and(
        eq(desktopEnrollments.code, normalized),
        eq(desktopEnrollments.status, "approved"),
        gt(desktopEnrollments.expiresAt, new Date()),
        isNull(desktopEnrollments.consumedAt)
      )
    )
    .returning()

  if (!redeemed?.userId) return null

  const token = newDeviceToken()
  const [device] = await db
    .insert(desktopDevices)
    .values({
      userId: redeemed.userId,
      name: redeemed.deviceName ?? "This computer",
      os: redeemed.os,
      tokenHash: hashDeviceToken(token),
      status: "online",
      lastSeenAt: new Date(),
    })
    .returning()

  return { device, token }
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export function isDeviceOnline(device: Pick<DesktopDevice, "status" | "lastSeenAt">) {
  if (device.status !== "online" || !device.lastSeenAt) return false
  return Date.now() - device.lastSeenAt.getTime() < ONLINE_WINDOW_MS
}

export async function listDevices(userId: string) {
  return db
    .select()
    .from(desktopDevices)
    .where(eq(desktopDevices.userId, userId))
    .orderBy(desc(desktopDevices.lastSeenAt), desc(desktopDevices.createdAt))
}

export async function getDevice(userId: string, id: string) {
  const [device] = await db
    .select()
    .from(desktopDevices)
    .where(and(eq(desktopDevices.id, id), eq(desktopDevices.userId, userId)))

  return device
}

export async function revokeDevice(userId: string, id: string) {
  const [revoked] = await db
    .update(desktopDevices)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(and(eq(desktopDevices.id, id), eq(desktopDevices.userId, userId)))
    .returning({ id: desktopDevices.id })

  if (!revoked) throw new Error("Device not found")
}

export async function setDevicePaused(
  userId: string,
  id: string,
  paused: boolean
) {
  const device = await getDevice(userId, id)
  if (!device) throw new Error("Device not found")
  if (device.status === "revoked") throw new Error("That device was revoked.")

  await db
    .update(desktopDevices)
    .set({ status: paused ? "paused" : "online" })
    .where(and(eq(desktopDevices.id, id), eq(desktopDevices.userId, userId)))
}

// One machine per person is the common case, so callers ask "is there a
// computer I can use" rather than passing an id around.
export async function onlineDevices(userId: string) {
  const devices = await listDevices(userId)
  return devices.filter(
    (device) => device.status === "online" && isDeviceOnline(device)
  )
}

export async function hasPausedDevice(userId: string) {
  const devices = await listDevices(userId)
  return devices.some((device) => device.status === "paused")
}

// ---------------------------------------------------------------------------
// Agent authentication
// ---------------------------------------------------------------------------

export type AgentIdentity = {
  userId: string
  deviceId: string | null
  // The token arrived on a device record rather than the legacy per-user row
  device: boolean
  // A paused device keeps its connection but must not claim new work
  paused: boolean
}

// Everything the poller sends authenticates here. A revoked device stops
// working immediately, because the token is looked up by its hash and the row's
// status is checked on every call.
export async function authenticateAgent(
  request: Request
): Promise<AgentIdentity | null> {
  const header = request.headers.get("authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  if (!token) return null

  const [device] = await db
    .select()
    .from(desktopDevices)
    .where(eq(desktopDevices.tokenHash, hashDeviceToken(token)))

  if (device) {
    if (device.status === "revoked") return null

    const agentVersion = request.headers.get("x-agent-version")?.slice(0, 40)

    // A paused device keeps its identity so the web can show it, but it must
    // not pick up new work: the poller treats 403 as "do nothing".
    await db
      .update(desktopDevices)
      .set({
        lastSeenAt: new Date(),
        ...(agentVersion ? { agentVersion } : {}),
      })
      .where(eq(desktopDevices.id, device.id))

    return {
      userId: device.userId,
      deviceId: device.id,
      device: true,
      paused: device.status === "paused",
    }
  }

  // Tokens created before devices existed keep working for the machine that
  // already has them, as an unattributed legacy agent.
  const [legacy] = await db
    .select()
    .from(integrations)
    .where(eq(integrations.pcAgentToken, token))

  if (!legacy) return null

  await db
    .update(integrations)
    .set({ pcAgentStatus: "online" })
    .where(eq(integrations.userId, legacy.userId))

  return { userId: legacy.userId, deviceId: null, device: false, paused: false }
}

export async function recordDeviceCapabilities(
  deviceId: string,
  capabilities: string[]
) {
  await db
    .update(desktopDevices)
    .set({ capabilities: capabilities.slice(0, 12) })
    .where(eq(desktopDevices.id, deviceId))
}

// ---------------------------------------------------------------------------
// Recent local jobs — what the settings page and Activity show
// ---------------------------------------------------------------------------

export async function recentDeviceJobs(userId: string, limit = 10) {
  return db
    .select({
      id: pcJobs.id,
      action: pcJobs.action,
      status: pcJobs.status,
      error: pcJobs.error,
      createdAt: pcJobs.createdAt,
      completedAt: pcJobs.completedAt,
    })
    .from(pcJobs)
    .where(eq(pcJobs.userId, userId))
    .orderBy(desc(pcJobs.createdAt))
    .limit(limit)
}

export async function anyDeviceBrowsing(userId: string) {
  const devices = await listDevices(userId)
  return devices.some(
    (device) =>
      device.status !== "revoked" &&
      device.capabilities.some((capability) => capability === "browser")
  )
}
