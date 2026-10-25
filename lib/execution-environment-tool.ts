// ---------------------------------------------------------------------------
// request_execution_environment — the question Godfather must ask before it
// browses anything the person did not place in an environment.
//
// The tool is the only way a task enters the browser queue, so the rule is
// structural rather than a good intention: no task, no environment, no
// browser. It answers in three shapes:
//
//   selected                       the person already named an environment
//   awaiting_execution_environment the card with buttons is now on screen
//   unavailable / api / direct     nothing to browse, or a route that is off
//
// The buttons are rendered by the chat from this result, and the click comes
// back through `resolveExecutionEnvironment` in actions/execution.ts.
// ---------------------------------------------------------------------------

import { tool } from "ai"
import { z } from "zod"

import { browserAvailability } from "@/lib/browser-adapters"
import {
  activeExecutionTask,
  createExecutionTask,
  ensureAwaitingExecutionTask,
  taskView,
} from "@/lib/execution-tasks"
import { decideExecutionRoute } from "@/lib/execution-router"

export type ExecutionEnvironmentTools = ReturnType<
  typeof createExecutionEnvironmentTools
>

export function createExecutionEnvironmentTools(ctx: {
  userId: string
  conversationId: string
}) {
  return {
    request_execution_environment: tool({
      description:
        "Decide where a task that needs a browser must run, and ask the person when they have not said. Call this BEFORE any browser_* tool for navigation, scraping, research or extraction. Return an `awaiting_execution_environment` card the person answers with buttons; nothing is opened until they choose. Skip it only when an already-authorized integration returns the data, or when the request needs no browser at all.",
      inputSchema: z.object({
        request: z
          .string()
          .min(3)
          .describe("What the person asked for, in their words, in one sentence"),
        needsBrowser: z
          .boolean()
          .optional()
          .describe(
            "True when this needs a real browser. False when the answer is plain reasoning or an API the person already connected."
          ),
        environment: z
          .enum(["local", "cloud"])
          .optional()
          .describe(
            "Only when the person named the environment themselves. Never guess it."
          ),
      }),
      execute: async ({ request, needsBrowser, environment }) => {
        const availability = await browserAvailability(ctx.userId)
        const decision = decideExecutionRoute({
          request,
          needsBrowser,
          explicitEnvironment: environment,
          availability,
        })

        if (decision.kind === "direct" || decision.kind === "api") {
          return { status: decision.kind, reason: decision.reason }
        }

        if (decision.kind === "blocked") {
          return {
            status: "unavailable" as const,
            environment: decision.environment,
            reason: decision.reason,
          }
        }

        if (decision.kind === "run") {
          // The person already chose: no question, just a task in that
          // environment. Reuse the one this chat is already running there.
          const active = await activeExecutionTask(ctx.conversationId, ctx.userId)
          if (active?.environment === decision.environment) {
            return {
              status: "selected" as const,
              taskId: active.id,
              environment: active.environment,
              reason: decision.reason,
            }
          }

          const task = await createExecutionTask({
            userId: ctx.userId,
            conversationId: ctx.conversationId,
            request,
            environment: decision.environment,
            reason: decision.reason,
            availability,
          })

          return {
            status: "selected" as const,
            taskId: task.id,
            environment: decision.environment,
            reason: decision.reason,
          }
        }

        // ask
        const task = await ensureAwaitingExecutionTask({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          request,
          reason: decision.reason,
          availability,
        })

        return {
          ...taskView(task),
          status: "awaiting_execution_environment" as const,
          // The card is the question; the model must stop here.
          next: "Wait for the person's choice. Do not open any page.",
        }
      },
    }),
  }
}
