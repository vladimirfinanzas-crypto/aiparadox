import { generateObject } from "ai"
import { asc, eq } from "drizzle-orm"
import { z } from "zod"

import { agentKinds, ORCHESTRATOR_ROLE } from "@/lib/agents"
import { db } from "@/db"
import { bots, type Bot } from "@/db/schema"
import type {
  ProviderSelection,
  RoleModelPreference,
} from "@/lib/ai/models"
import type { ModelRole } from "@/lib/ai/types"
import { getRoutingModel } from "@/lib/model"

// Everyone the router may choose between. This runs inside the Trigger.dev
// chat task, where there is no session, so it takes the user id directly
// instead of asking Clerk who is calling.
export async function getRoutingCandidates(userId: string): Promise<Bot[]> {
  return db.query.bots.findMany({
    where: eq(bots.userId, userId),
    orderBy: asc(bots.createdAt),
  })
}

// The router that answers "which agent should take this?" so the person never
// has to. One small structured call per turn: it reads the candidates and the
// message, and returns the agent whose job and kind fit the work.
//
// It is deliberately conservative — if anything is unclear it keeps the agent
// that was already there, so a routing failure degrades into the old behaviour
// instead of a broken conversation.

const decisionSchema = z.object({
  agentId: z.string().describe("The id of the agent that should take this task"),
  reason: z.string().max(200).describe("Why, in one short sentence"),
})

// Routing is an optimisation that runs before the turn starts, so it may never
// be the reason a reply is late. The model gets 4.5s (enough for the primary and
// one fallback); after that the orchestrator answers and the person is not kept
// waiting on a classification.
export const ROUTING_DEADLINE_MS = 4_500

export type RouteDecision = {
  bot: Bot
  reason: string
  // True when the router actually chose, false when it fell back
  routed: boolean
}

// Whichever agent speaks plain conversation, used when the router is unsure
function fallback(candidates: Bot[]): Bot {
  return (
    candidates.find((bot) => bot.kind === "chat" && bot.source === "default") ??
    candidates.find((bot) => bot.kind === "chat") ??
    candidates[0]
  )
}

export async function pickAgent(
  candidates: Bot[],
  message: string,
  /** The person's provider order/opt-outs, so routing follows their choices. */
  selection?: ProviderSelection,
  /** Their chosen model per role, including the one that decides routing. */
  preferences?: Partial<Record<ModelRole, RoleModelPreference>>
): Promise<RouteDecision> {
  if (candidates.length === 0) throw new Error("No agent available in this chat")

  // The orchestrator ("Godfather") is the entry point of every conversation: it
  // welcomes the person, understands the request and coordinates the rest. It is
  // never chosen by the router itself — the router picks a specialist to do the
  // work, or falls back below.
  const orchestrator = candidates.find(
    (bot) => bot.role === ORCHESTRATOR_ROLE
  )

  if (candidates.length === 1) {
    return { bot: candidates[0], reason: "Only one agent", routed: false }
  }

  const specialists = candidates.filter(
    (bot) => bot.role !== ORCHESTRATOR_ROLE
  )

  const trimmed = message.trim()
  if (!trimmed) {
    return {
      bot: orchestrator ?? fallback(specialists),
      reason: "No message yet",
      routed: false,
    }
  }

  const catalogue = specialists
    .map(
      (bot) =>
        `- id: ${bot.id} · name: ${bot.name} · kind: ${bot.kind} · job: ${bot.job}` +
        (bot.instructions ? ` · how it works: ${bot.instructions.slice(0, 240)}` : "")
    )
    .join("\n")

  try {
    const { object } = await generateObject({
      model: getRoutingModel(selection, preferences),
      schema: decisionSchema,
      abortSignal: AbortSignal.timeout(ROUTING_DEADLINE_MS),
      system: [
        "You route one request to the right agent in a product with these agents:",
        catalogue,
        "",
        "Kinds and what they can do:",
        ...Object.entries(agentKinds).map(
          ([kind, info]) => `- ${kind}: ${info.summary}`
        ),
        "",
        "Pick the single best agent for the request. Prefer the agent whose job is closest to the work, not the one with the most tools. A request that needs the browser goes to a browser agent, one that needs a computer goes to a computer agent, one that publishes goes to a social agent, and ordinary writing, analysis, translation or question answering goes to a chat agent.",
        "The message may be in Spanish or English; answer in the same language and do not let the language decide the agent.",
        "Always answer with an id from the list above.",
      ].join("\n"),
      prompt: trimmed.slice(0, 6000),
    })

    const chosen = specialists.find((bot) => bot.id === object.agentId)
    if (!chosen) {
      return {
        bot: orchestrator ?? fallback(specialists),
        reason: "Unknown id",
        routed: false,
      }
    }

    return { bot: chosen, reason: object.reason, routed: true }
  } catch (error) {
    // Routing is an optimisation, never a reason to fail a conversation. A
    // deadline is the common case: the turn goes to the orchestrator, which can
    // still do the work itself or hand it off.
    return {
      bot: orchestrator ?? fallback(specialists),
      reason:
        error instanceof Error && error.name === "TimeoutError"
          ? "Router deadline"
          : "Router unavailable",
      routed: false,
    }
  }
}

// The last thing the person actually said, which is what gets routed. Edits,
// tool results and system parts are not their request.
export function latestUserText(
  messages: { role: string; content: unknown }[]
): string {
  const last = [...messages].reverse().find((message) => message.role === "user")
  if (!last) return ""

  if (typeof last.content === "string") return last.content

  if (Array.isArray(last.content)) {
    return last.content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text
          return typeof text === "string" ? text : ""
        }
        return ""
      })
      .join(" ")
  }

  return ""
}
