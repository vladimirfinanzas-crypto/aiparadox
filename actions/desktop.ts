"use server"

import { auth } from "@clerk/nextjs/server"
import { revalidatePath } from "next/cache"

import {
  approveEnrollment,
  revokeDevice,
  setDevicePaused,
} from "@/lib/desktop-devices"

// Everything here runs with the signed-in person's own id: a code, a device id
// or a "paused" flag from the browser can only ever affect their account.

export async function approveDesktopCode(formData: FormData) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const code = String(formData.get("code") ?? "").trim()
  if (!code) throw new Error("Enter the code shown by the agent.")

  await approveEnrollment({ code, userId })
  revalidatePath("/settings/desktop-agent")
}

export async function revokeDesktopDevice(formData: FormData) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const id = String(formData.get("id") ?? "")
  if (!id) throw new Error("Missing device")

  await revokeDevice(userId, id)
  revalidatePath("/settings/desktop-agent")
}

export async function pauseDesktopDevice(formData: FormData) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const id = String(formData.get("id") ?? "")
  if (!id) throw new Error("Missing device")

  await setDevicePaused(userId, id, true)
  revalidatePath("/settings/desktop-agent")
}

export async function resumeDesktopDevice(formData: FormData) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const id = String(formData.get("id") ?? "")
  if (!id) throw new Error("Missing device")

  await setDevicePaused(userId, id, false)
  revalidatePath("/settings/desktop-agent")
}
