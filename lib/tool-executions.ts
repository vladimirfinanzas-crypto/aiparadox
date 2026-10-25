// ---------------------------------------------------------------------------
// Execution Manager for tool calls.
//
// Every tool Godfather invokes goes through `wrapToolsForExecution`: one row
// per call with a unique id, its state (running → completed | failed), the
// arguments it was given, its result or its error, and its timestamps. The row
// is what Activity shows and what a later turn can be asked about.
//
// Recording is deliberately best-effort: a failure to write the log never
// fails the tool it was logging. Results are truncated so a screenshot's
// base64 payload does not land in the database — the row stores what happened,
// not the raw media.
//
// Long-running work is not done here. Durable tasks (Trigger.dev runs, the
// desktop job queue, automation executions) own their own state; this records
// the tool-call layer that ties a conversation to those systems.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm"

import { db } from "@/db"
import { executions } from "@/db/schema"

export type ToolExecutionContext = {
  userId: string
  /** The chat the call happened in, so Activity can link back to it. */
  conversationId: string
}

const ARG_CHARS = 1_000
const RESULT_CHARS = 2_000

function truncate(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function summarizeArgs(args: unknown): string {
  try {
    return truncate(JSON.stringify(args ?? {}), ARG_CHARS)
  } catch {
    return "(unserializable arguments)"
  }
}

function summarizeResult(output: unknown): string {
  if (output === undefined || output === null) return ""
  if (typeof output === "string") return truncate(output, RESULT_CHARS)
  try {
    return truncate(JSON.stringify(output), RESULT_CHARS)
  } catch {
    return truncate(String(output), RESULT_CHARS)
  }
}

function summarizeError(error: unknown): string {
  return truncate(
    error instanceof Error ? error.message : String(error),
    RESULT_CHARS
  )
}

// Writing the row must never break the call it is recording
async function insertRunning(
  ctx: ToolExecutionContext,
  toolName: string,
  args: unknown
): Promise<string | null> {
  try {
    const [row] = await db
      .insert(executions)
      .values({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        role: "tool",
        prompt: `${toolName} ${summarizeArgs(args)}`.trim(),
        status: "running",
        startedAt: new Date(),
      })
      .returning({ id: executions.id })
    return row.id ?? null
  } catch {
    return null
  }
}

async function finish(
  id: string | null,
  patch: { status: string; result?: string; error?: string }
) {
  if (!id) return
  try {
    await db
      .update(executions)
      .set({ ...patch, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(executions.id, id))
  } catch {
    // Already reported by Sentry elsewhere; the tool result is unaffected
  }
}

type Executable = { execute?: (...args: never[]) => unknown }

/**
 * Wraps every tool that has an `execute` so each call is recorded. Tool names,
 * schemas and `toModelOutput` helpers are left untouched: trigger.dev replays
 * earlier turns by tool name, and only the body is observed.
 */
export function wrapToolsForExecution<
  T extends Record<string, unknown>,
>(tools: T, ctx: ToolExecutionContext): T {
  const wrapped: Record<string, unknown> = {}

  for (const [name, value] of Object.entries(tools)) {
    const candidate = value as Executable | undefined
    const execute = candidate?.execute

    if (typeof execute !== "function") {
      wrapped[name] = value
      continue
    }

    wrapped[name] = {
      ...candidate,
      execute: async (...args: unknown[]) => {
        const id = await insertRunning(ctx, name, args[0])
        try {
          const output = await (execute as (...a: unknown[]) => unknown)(...args)
          await finish(id, { status: "completed", result: summarizeResult(output) })
          return output
        } catch (error) {
          await finish(id, { status: "failed", error: summarizeError(error) })
          throw error
        }
      },
    }
  }

  return wrapped as T
}
