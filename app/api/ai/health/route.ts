import { auth } from "@clerk/nextjs/server"

import { checkAiHealth } from "@/lib/ai-health"

// Reads the live OpenRouter catalogue (and, with ?probe=1, calls every model),
// so this answer is never cached.
export const dynamic = "force-dynamic"

// The AI runtime's own health: whether the key is visible to the server, every
// configured model id, and — with ?probe=1 — how long each one takes to answer.
// Signed-in only: the model list and error messages describe the backend.
export async function GET(request: Request) {
  const { isAuthenticated } = await auth()
  if (!isAuthenticated) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const probe = new URL(request.url).searchParams.get("probe") === "1"
  const health = await checkAiHealth({ probe })

  return Response.json(health, {
    headers: { "Cache-Control": "no-store" },
  })
}
