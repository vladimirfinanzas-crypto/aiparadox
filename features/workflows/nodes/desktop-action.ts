import type { PcAction } from "@/db/schema"
import { pcAgentSetup, runPcAction } from "@/lib/pc"

// The desktop block: one PyAutoGUI action on the person's own computer, queued
// for their local agent and waited on. Everything is composed from the small
// action vocabulary rather than shipping code to run.
export async function desktopAction({
  userId,
  values,
}: {
  userId: string
  values: Record<string, string>
}) {
  const action = (values.action ?? "").trim().toLowerCase()
  const value = values.value ?? ""
  const x = Number(values.x)
  const y = Number(values.y)

  const needsPoint = action === "click" || action === "move"
  if (needsPoint && (!Number.isFinite(x) || !Number.isFinite(y))) {
    throw new Error(`${action} needs X and Y coordinates in pixels.`)
  }

  let step: PcAction
  switch (action) {
    case "screenshot":
      step = { kind: "screenshot" }
      break
    case "move":
      step = { kind: "move", x, y }
      break
    case "click":
      step = { kind: "click", x, y }
      break
    case "type":
      if (!value) throw new Error("Nothing to type.")
      step = { kind: "type", text: value }
      break
    case "press":
      if (!value) throw new Error("Name the key to press.")
      step = { kind: "press", key: value }
      break
    case "hotkey":
      step = { kind: "hotkey", keys: value.split("+").map((key) => key.trim()) }
      break
    case "scroll":
      step = { kind: "scroll", dx: 0, dy: Number(value) || 0 }
      break
    case "run":
      if (!value) throw new Error("Name the program to run.")
      step = { kind: "run", command: value }
      break
    default:
      throw new Error(
        "Action must be one of: screenshot, move, click, type, press, hotkey, scroll, run."
      )
  }

  try {
    const result = await runPcAction(userId, step)
    return { result: JSON.stringify(result).slice(0, 8000) }
  } catch (error) {
    // The setup instructions are the useful answer when nothing is listening
    if (error instanceof Error && error.message.includes("install the local agent")) {
      const setup = await pcAgentSetup(userId)
      throw new Error(`${error.message} Token: ${setup.token}`)
    }
    throw error
  }
}
