// ---------------------------------------------------------------------------
// Execution tasks — the row that ties a conversation to work done somewhere
// other than Godfather's own sandbox.
//
// The lifecycle is explicit:
//
//   awaiting_execution_environment   the question is on screen, nothing runs
//            │ selected                     │ cancelled
//            ▼                              ▼
//         queued ──▶ running ──▶ completed | failed        cancelled
//
// Every transition is a conditional UPDATE, so two clicks on the same card, two
// tabs, or a retried request can never start the same work twice. Reads are
// always scoped by user id; a task id from another account simply does not
// exist.
// ---------------------------------------------------------------------------

import { and, desc, eq, inArray, sql } from "drizzle-orm"

import { db } from "@/db"
import {
  executionTasks,
  type ExecutionEnvironment,
  type ExecutionTask,
  type ExecutionTaskEvent,
  type ExecutionTaskStatus,
} from "@/db/schema"
import {
  checkResolution,
  environmentOptions,
  type EnvironmentAvailability,
  type EnvironmentChoice,
} from "@/lib/execution-router"

/** How long an unanswered question is reused instead of asked again. */
const AWAITING_REUSE_MS = 30 * 60_000

const nonTerminal: ExecutionTaskStatus[] = [
  "awaiting_execution_environment",
  "queued",
  "running",
]

function event(kind: string, detail?: string): ExecutionTaskEvent {
  return { at: new Date().toISOString(), kind, ...(detail ? { detail } : {}) }
}

export type ExecutionTaskView = {
  id: string
  status: ExecutionTask["status"]
  environment: ExecutionEnvironment | null
  request: string
  question: string
  options: ReturnType<typeof environmentOptions>
  reason: string | null
  error: string | null
  createdAt: string
  decidedAt: string | null
}

/** What the chat card and the tool output both render. */
export function taskView(task: ExecutionTask): ExecutionTaskView {
  const stored = task.options ?? []
  return {
    id: task.id,
    status: task.status,
    environment: task.environment ?? null,
    request: task.request,
    question: "¿Dónde quieres ejecutar esta tarea?",
    // Only a pending task shows buttons; a resolved one shows what was chosen.
    options:
      task.status === "awaiting_execution_environment"
        ? (stored as ReturnType<typeof environmentOptions>)
        : [],
    reason: task.reason ?? null,
    error: task.error ?? null,
    createdAt: task.createdAt.toISOString(),
    decidedAt: task.decidedAt?.toISOString() ?? null,
  }
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export async function createExecutionTask({
  userId,
  conversationId,
  request,
  environment,
  reason,
  availability,
}: {
  userId: string
  conversationId?: string
  request: string
  environment?: ExecutionEnvironment
  reason?: string
  availability?: EnvironmentAvailability
}): Promise<ExecutionTask> {
  const decided = Boolean(environment)
  // The buttons and their disabled flags are stored with the task, so the card
  // is identical after a reload even if configuration changed since.
  const options = availability
    ? environmentOptions(availability)
    : environmentOptions({
        cloud: { available: true },
        local: { available: true },
      })

  const [task] = await db
    .insert(executionTasks)
    .values({
      userId,
      conversationId,
      request: request.slice(0, 2_000),
      environment,
      status: decided ? "queued" : "awaiting_execution_environment",
      reason,
      options,
      events: [
        event("created"),
        ...(decided ? [event("environment_selected", environment)] : []),
      ],
    })
    .returning()

  return task
}

/**
 * One question per conversation: if the same chat is still waiting for an
 * answer, that task is returned instead of a second one being created. A model
 * that calls the tool twice in a turn, or a turn that is retried, therefore
 * still shows a single card.
 */
export async function ensureAwaitingExecutionTask({
  userId,
  conversationId,
  request,
  reason,
  availability,
}: {
  userId: string
  conversationId: string
  request: string
  reason?: string
  availability: EnvironmentAvailability
}): Promise<ExecutionTask> {
  const [existing] = await db
    .select()
    .from(executionTasks)
    .where(
      and(
        eq(executionTasks.userId, userId),
        eq(executionTasks.conversationId, conversationId),
        eq(executionTasks.status, "awaiting_execution_environment")
      )
    )
    .orderBy(desc(executionTasks.createdAt))
    .limit(1)

  if (
    existing &&
    Date.now() - existing.createdAt.getTime() < AWAITING_REUSE_MS
  ) {
    // The question stays the same one; only the wording of the request is
    // refreshed, so the card in the conversation keeps its id.
    if (request.trim() && request.trim() !== existing.request) {
      await db
        .update(executionTasks)
        .set({ request: request.slice(0, 2_000) })
        .where(eq(executionTasks.id, existing.id))
    }
    return existing
  }

  const created = await createExecutionTask({
    userId,
    conversationId,
    request,
    reason,
    availability,
  })
  return created
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getExecutionTask(
  taskId: string,
  userId: string
): Promise<ExecutionTask | null> {
  const [task] = await db
    .select()
    .from(executionTasks)
    .where(and(eq(executionTasks.id, taskId), eq(executionTasks.userId, userId)))
  return task ?? null
}

/**
 * The task a browser tool should act on: the newest one in this conversation
 * whose environment has been chosen and whose work has not ended. There is
 * never a "current page" shared between tasks — each task answers for itself.
 */
export async function activeExecutionTask(
  conversationId: string,
  userId: string
): Promise<ExecutionTask | null> {
  const [task] = await db
    .select()
    .from(executionTasks)
    .where(
      and(
        eq(executionTasks.userId, userId),
        eq(executionTasks.conversationId, conversationId),
        inArray(executionTasks.status, ["queued", "running"])
      )
    )
    .orderBy(desc(executionTasks.createdAt))
    .limit(1)

  return task && task.environment ? task : null
}

export async function listRecentExecutionTasks(
  userId: string,
  limit = 10
): Promise<ExecutionTask[]> {
  return db
    .select()
    .from(executionTasks)
    .where(eq(executionTasks.userId, userId))
    .orderBy(desc(executionTasks.createdAt))
    .limit(limit)
}

// ---------------------------------------------------------------------------
// Resolution — the click
// ---------------------------------------------------------------------------

export type ResolutionResult =
  | {
      kind: "selected"
      task: ExecutionTask
      environment: ExecutionEnvironment
      duplicate: boolean
    }
  | { kind: "cancelled"; task: ExecutionTask }
  | {
      kind: "rejected"
      code: "not_owner" | "not_pending" | "unavailable"
      message: string
    }

/**
 * Records the person's answer. The conditional update is what makes repeated
 * clicks safe: the first one wins and the rest see the resolved row.
 */
export async function respondToExecutionEnvironment({
  taskId,
  requesterId,
  choice,
  availability,
}: {
  taskId: string
  requesterId: string
  choice: EnvironmentChoice
  availability: EnvironmentAvailability
}): Promise<ResolutionResult> {
  const task = await getExecutionTask(taskId, requesterId)
  const check = checkResolution({
    task,
    requesterId,
    choice,
    availability,
  })

  if (!check.ok) {
    return { kind: "rejected", code: check.code, message: check.message }
  }
  if (!task) {
    return { kind: "rejected", code: "not_owner", message: "Task not found" }
  }
  if (check.duplicate) {
    return {
      kind: "selected",
      task,
      environment: (check.environment ?? task.environment) as ExecutionEnvironment,
      duplicate: true,
    }
  }

  if (check.choice === "cancel") {
    const [cancelled] = await db
      .update(executionTasks)
      .set({
        status: "cancelled",
        completedAt: new Date(),
        events: appendEvents(task.events, [event("cancelled")]),
      })
      .where(
        and(
          eq(executionTasks.id, task.id),
          eq(executionTasks.userId, requesterId),
          eq(executionTasks.status, "awaiting_execution_environment")
        )
      )
      .returning()

    return { kind: "cancelled", task: cancelled ?? task }
  }

  const environment = check.choice
  const [resolved] = await db
    .update(executionTasks)
    .set({
      environment,
      status: "queued",
      decidedAt: new Date(),
      reason:
        environment === "cloud"
          ? "The person chose the cloud browser."
          : "The person chose their own computer.",
      events: appendEvents(task.events, [
        event("environment_selected", environment),
      ]),
    })
    .where(
      and(
        eq(executionTasks.id, task.id),
        eq(executionTasks.userId, requesterId),
        eq(executionTasks.status, "awaiting_execution_environment")
      )
    )
    .returning()

  if (!resolved) {
    // Someone else resolved it between the read and the write: report what was
    // actually chosen rather than starting the work again.
    const current = await getExecutionTask(taskId, requesterId)
    if (current?.environment) {
      return {
        kind: "selected",
        task: current,
        environment: current.environment,
        duplicate: true,
      }
    }
    return {
      kind: "rejected",
      code: "not_pending",
      message: "That task is no longer waiting for an environment.",
    }
  }

  return { kind: "selected", task: resolved, environment, duplicate: false }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export async function markExecutionTaskRunning(taskId: string) {
  await db
    .update(executionTasks)
    .set({ status: "running", startedAt: new Date() })
    .where(
      and(
        eq(executionTasks.id, taskId),
        inArray(executionTasks.status, ["queued", "running"])
      )
    )
}

export async function completeExecutionTask(
  taskId: string,
  { error }: { error?: string } = {}
) {
  const [task] = await db
    .select({ events: executionTasks.events })
    .from(executionTasks)
    .where(eq(executionTasks.id, taskId))

  await db
    .update(executionTasks)
    .set({
      status: error ? "failed" : "completed",
      error: error?.slice(0, 2_000),
      completedAt: new Date(),
      events: appendEvents(task?.events ?? [], [
        error ? event("failed", error) : event("completed"),
      ]),
    })
    .where(eq(executionTasks.id, taskId))
}

export async function recordExecutionTaskEvent(
  taskId: string,
  entry: ExecutionTaskEvent
) {
  // One statement, so concurrent steps never overwrite each other's line
  await db
    .update(executionTasks)
    .set({
      events: sql`coalesce(${executionTasks.events}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
    })
    .where(eq(executionTasks.id, taskId))
}

export async function recordBrowserSession(
  taskId: string,
  browserSessionId: string | null
) {
  await db
    .update(executionTasks)
    .set({ browserSessionId })
    .where(eq(executionTasks.id, taskId))
}

/**
 * Closes every task of one conversation when its turn ends. Work does not
 * continue between turns, so a row left as `running` would be a lie in
 * Activity. A question that is still waiting for an answer is left alone: it
 * belongs to the next turn.
 */
export async function completeConversationTasks(
  conversationId: string,
  error?: string
): Promise<number> {
  const rows = await db
    .select({ id: executionTasks.id, events: executionTasks.events })
    .from(executionTasks)
    .where(
      and(
        eq(executionTasks.conversationId, conversationId),
        inArray(executionTasks.status, ["queued", "running"])
      )
    )

  await Promise.all(
    rows.map((row) => {
      const events = row.events ?? []
      const stepped = events.some((entry) => entry.kind === "step")
      const failedStep = events.some((entry) => entry.kind === "error")

      // "Completed" means the execution ran and ended without an error. A task
      // that never took a single step is not reported as done: the turn ended
      // before anything happened in that environment.
      const reason =
        error ??
        (failedStep
          ? "A browser step failed before the turn ended."
          : stepped
            ? undefined
            : "The turn ended before the task ran a single step.")

      return completeExecutionTask(row.id, { error: reason })
    })
  )

  return rows.length
}

/** Old tasks that never finished are closed instead of piling up in Activity. */
export async function expireStaleExecutionTasks(maxAgeMs = 6 * 60 * 60_000) {
  const cutoff = new Date(Date.now() - maxAgeMs)
  await db
    .update(executionTasks)
    .set({ status: "failed", error: "The task expired before it finished." })
    .where(
      and(
        inArray(executionTasks.status, nonTerminal),
        sql`${executionTasks.createdAt} < ${cutoff}`
      )
    )
}

function appendEvents(
  current: ExecutionTaskEvent[] | null | undefined,
  added: ExecutionTaskEvent[]
) {
  return [...(current ?? []), ...added].slice(-60)
}
