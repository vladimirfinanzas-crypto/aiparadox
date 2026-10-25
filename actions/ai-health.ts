"use server"

import { auth } from "@clerk/nextjs/server"

import { checkAiHealth, type AiHealth } from "@/lib/ai-health"

// Runs the model probes on demand. Signed-in only: the result names the models
// the backend uses and any provider error they return.
export async function checkModelsAction(): Promise<AiHealth> {
  const { isAuthenticated } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  return checkAiHealth({ probe: true })
}
