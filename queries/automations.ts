import { and, desc, eq, inArray, sql } from "drizzle-orm"

import { db } from "@/db"
import {
  automationApprovals,
  automationRuns,
  automationRunSteps,
  automationSchedules,
  automationVersions,
  workflows,
  type AutomationApproval,
  type AutomationRun,
  type AutomationRunOrigin,
  type AutomationRunStatus,
  type AutomationRunStep,
  type AutomationSchedule,
  type AutomationStatus,
  type AutomationStepStatus,
  type Workflow,
} from "@/db/schema"
import { automationScopeHash } from "@/lib/automations/approvals"
import {
  definitionKey,
  executionTargetOfDefinition,
  type AutomationDefinition,
} from "@/lib/automations/definition"
import { availableEnvNames } from "@/lib/automations/env"
import { validateDefinition } from "@/lib/automations/validate"

// Every function here takes the Clerk user id as its first argument and puts it
// in the WHERE clause. Nothing returns or edits a row that belongs to somebody
// else, whatever id the caller sends.

const MAX_RUNS = 50

export class AutomationNotFoundError extends Error {
  constructor() {
    super("Esa automatización no existe en tu cuenta.")
    this.name = "AutomationNotFoundError"
  }
}

/** Validation errors, in the shape the editor and Godfather both render. */
export class AutomationInvalidError extends Error {
  issues: Array<{ code: string; message: string; nodeId?: string }>

  constructor(issues: Array<{ code: string; message: string; nodeId?: string }>) {
    super(issues[0]?.message ?? "La automatización no es válida.")
    this.name = "AutomationInvalidError"
    this.issues = issues
  }
}

export type AutomationListItem = {
  id: string
  name: string
  description: string | null
  status: AutomationStatus
  timezone: string
  version: number
  executionTarget: Workflow["executionTarget"]
  nextRunAt: Date | null
  lastRunAt: Date | null
  updatedAt: Date
  nodeCount: number
  triggerKind: AutomationDefinition["trigger"]["kind"]
  trigger: AutomationDefinition["trigger"] | null
}

export async function listAutomations(userId: string): Promise<AutomationListItem[]> {
  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      description: workflows.description,
      status: workflows.status,
      timezone: workflows.timezone,
      version: workflows.version,
      executionTarget: workflows.executionTarget,
      nextRunAt: workflows.nextRunAt,
      lastRunAt: workflows.lastRunAt,
      updatedAt: workflows.updatedAt,
      definition: workflows.definition,
    })
    .from(workflows)
    .where(eq(workflows.userId, userId))
    .orderBy(desc(workflows.updatedAt))

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    timezone: row.timezone,
    version: row.version,
    executionTarget: row.executionTarget,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    updatedAt: row.updatedAt,
    nodeCount: row.definition?.nodes.length ?? 0,
    triggerKind: row.definition?.trigger.kind ?? "manual",
    trigger: row.definition?.trigger ?? null,
  }))
}

export async function getAutomation(userId: string, id: string): Promise<Workflow | null> {
  const [row] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, id), eq(workflows.userId, userId)))
  return row ?? null
}

export async function requireAutomation(userId: string, id: string): Promise<Workflow> {
  const row = await getAutomation(userId, id)
  if (!row) throw new AutomationNotFoundError()
  return row
}

export async function createAutomation({
  userId,
  name,
  timezone = "UTC",
  definition,
  author = "user",
}: {
  userId: string
  name: string
  timezone?: string
  definition: AutomationDefinition
  author?: "user" | "godfather"
}): Promise<Workflow> {
  const report = validateDefinition(definition, { availableEnv: availableEnvNames() })
  const errors = report.errors.map((issue) => ({
    code: issue.code,
    message: issue.message,
    nodeId: issue.nodeId,
  }))
  if (errors.length > 0) throw new AutomationInvalidError(errors)

  const [row] = await db
    .insert(workflows)
    .values({
      userId,
      name,
      description: definition.description ?? null,
      definition,
      version: 1,
      status: "draft",
      timezone: definition.trigger.timezone || timezone,
      executionTarget: executionTargetOfDefinition(definition),
    })
    .returning()

  await db.insert(automationVersions).values({
    workflowId: row!.id,
    userId,
    version: 1,
    definition,
    author,
    summary: "Versión inicial",
  })

  return row!
}

/** The one write path for a definition: validate, bump the version, freeze it,
 *  and drop back to `pending_approval` when the consequences changed. */
export async function saveAutomationDefinition({
  userId,
  id,
  definition,
  author = "user",
  summary,
}: {
  userId: string
  id: string
  definition: AutomationDefinition
  author?: "user" | "godfather"
  summary?: string
}): Promise<{ automation: Workflow; version: number; status: AutomationStatus; unchanged: boolean }> {
  const current = await requireAutomation(userId, id)

  const report = validateDefinition(definition, { availableEnv: availableEnvNames() })
  if (!report.ok) {
    throw new AutomationInvalidError(
      report.errors.map((issue) => ({
        code: issue.code,
        message: issue.message,
        nodeId: issue.nodeId,
      }))
    )
  }

  // Nothing changed: do not create an empty version or reset an approval.
  if (current.definition && definitionKey(current.definition) === definitionKey(definition)) {
    return { automation: current, version: current.version, status: current.status, unchanged: true }
  }

  const nextVersion = current.version + 1
  const previousHash = current.definition ? automationScopeHash(current.definition) : null
  const nextHash = automationScopeHash(definition)
  const consequencesChanged = previousHash !== nextHash

  const status: AutomationStatus =
    consequencesChanged && (current.status === "active" || current.status === "pending_approval")
      ? "pending_approval"
      : current.status

  const [updated] = await db
    .update(workflows)
    .set({
      definition,
      version: nextVersion,
      status,
      name: definition.name,
      description: definition.description ?? null,
      timezone: definition.trigger.timezone,
      executionTarget: executionTargetOfDefinition(definition),
      updatedAt: new Date(),
      // A definition that stopped being active must not advertise a next run.
      nextRunAt: status === "active" ? current.nextRunAt : null,
    })
    .where(and(eq(workflows.id, id), eq(workflows.userId, userId)))
    .returning()

  await db.insert(automationVersions).values({
    workflowId: id,
    userId,
    version: nextVersion,
    definition,
    author,
    summary: summary ?? (author === "godfather" ? "Cambio propuesto por Godfather" : "Edición en el lienzo"),
  })

  return { automation: updated!, version: nextVersion, status, unchanged: false }
}

export async function updateAutomationMeta({
  userId,
  id,
  name,
  description,
}: {
  userId: string
  id: string
  name?: string
  description?: string | null
}): Promise<Workflow> {
  const current = await requireAutomation(userId, id)

  const definition = current.definition
    ? {
        ...current.definition,
        name: name ?? current.definition.name,
        ...(description !== undefined ? { description: description ?? undefined } : {}),
      }
    : null

  const [updated] = await db
    .update(workflows)
    .set({
      name: name ?? current.name,
      description: description === undefined ? current.description : description,
      ...(definition ? { definition } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(workflows.id, id), eq(workflows.userId, userId)))
    .returning()

  return updated!
}

export async function deleteAutomation(userId: string, id: string): Promise<Workflow | null> {
  const [row] = await db
    .delete(workflows)
    .where(and(eq(workflows.id, id), eq(workflows.userId, userId)))
    .returning()
  return row ?? null
}

export async function setAutomationStatus({
  userId,
  id,
  status,
  nextRunAt,
  activatedAt,
}: {
  userId: string
  id: string
  status: AutomationStatus
  nextRunAt?: Date | null
  activatedAt?: Date | null
}): Promise<Workflow> {
  const [updated] = await db
    .update(workflows)
    .set({
      status,
      updatedAt: new Date(),
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      ...(activatedAt !== undefined ? { activatedAt } : {}),
    })
    .where(and(eq(workflows.id, id), eq(workflows.userId, userId)))
    .returning()

  if (!updated) throw new AutomationNotFoundError()
  return updated
}

export async function markAutomationRun({
  userId,
  id,
  at,
  nextRunAt,
}: {
  userId: string
  id: string
  at: Date
  nextRunAt?: Date | null
}): Promise<void> {
  await db
    .update(workflows)
    .set({
      lastRunAt: at,
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    })
    .where(and(eq(workflows.id, id), eq(workflows.userId, userId)))
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export async function getVersion({
  userId,
  workflowId,
  version,
}: {
  userId: string
  workflowId: string
  version: number
}): Promise<AutomationDefinition | null> {
  const [row] = await db
    .select({ definition: automationVersions.definition })
    .from(automationVersions)
    .where(
      and(
        eq(automationVersions.workflowId, workflowId),
        eq(automationVersions.userId, userId),
        eq(automationVersions.version, version)
      )
    )
  return row?.definition ?? null
}

export async function listVersions({ userId, workflowId }: { userId: string; workflowId: string }) {
  return db
    .select({
      version: automationVersions.version,
      author: automationVersions.author,
      summary: automationVersions.summary,
      createdAt: automationVersions.createdAt,
    })
    .from(automationVersions)
    .where(
      and(eq(automationVersions.workflowId, workflowId), eq(automationVersions.userId, userId))
    )
    .orderBy(desc(automationVersions.version))
    .limit(20)
}

// ---------------------------------------------------------------------------
// Runs and steps
// ---------------------------------------------------------------------------

export async function createRun({
  userId,
  workflowId,
  version,
  origin,
  environment,
  idempotencyKey,
}: {
  userId: string
  workflowId: string
  version: number
  origin: AutomationRunOrigin
  environment: "cloud" | "local" | "hybrid"
  idempotencyKey?: string
}): Promise<AutomationRun> {
  const [row] = await db
    .insert(automationRuns)
    .values({
      userId,
      workflowId,
      version,
      origin,
      environment,
      status: "queued",
      ...(idempotencyKey ? { idempotencyKey } : {}),
    })
    // The unique index on idempotency_key is partial, so it cannot be named as
    // an arbiter target; a bare do-nothing covers it (the id is generated, and
    // trigger_run_id is null on insert).
    .onConflictDoNothing()
    .returning()

  if (row) return row

  // The same idempotency key already produced a run: hand back the original
  // instead of starting the work twice.
  const [existing] = await db
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.idempotencyKey, idempotencyKey!),
        eq(automationRuns.userId, userId)
      )
    )
  return existing!
}

export async function attachTriggerRun(runId: string, triggerRunId: string): Promise<void> {
  await db.update(automationRuns).set({ triggerRunId }).where(eq(automationRuns.id, runId))
}

export async function markRunRunning(runId: string): Promise<void> {
  await db
    .update(automationRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(automationRuns.id, runId))
}

export async function finishRun({
  runId,
  status,
  error,
  output,
  durationMs,
  environment,
}: {
  runId: string
  status: AutomationRunStatus
  error?: string
  output?: Record<string, unknown>
  durationMs?: number
  environment?: "cloud" | "local" | "hybrid"
}): Promise<void> {
  await db
    .update(automationRuns)
    .set({
      status,
      finishedAt: new Date(),
      ...(error !== undefined ? { error } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(environment ? { environment } : {}),
    })
    .where(eq(automationRuns.id, runId))
}

export async function getRun({
  userId,
  runId,
}: {
  userId: string
  runId: string
}): Promise<{ run: AutomationRun; steps: AutomationRunStep[] } | null> {
  const [run] = await db
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.userId, userId)))
  if (!run) return null

  const steps = await db
    .select()
    .from(automationRunSteps)
    .where(eq(automationRunSteps.runId, run.id))
    .orderBy(automationRunSteps.startedAt)

  return { run, steps }
}

export async function listRuns({
  userId,
  workflowId,
  limit = 20,
}: {
  userId: string
  workflowId: string
  limit?: number
}): Promise<AutomationRun[]> {
  return db
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.workflowId, workflowId), eq(automationRuns.userId, userId)))
    .orderBy(desc(automationRuns.startedAt))
    .limit(Math.min(limit, MAX_RUNS))
}

export async function latestRunFor(userId: string, workflowId: string) {
  const [row] = await db
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.workflowId, workflowId), eq(automationRuns.userId, userId)))
    .orderBy(desc(automationRuns.startedAt))
    .limit(1)
  return row ?? null
}

export async function seedRunSteps(
  runId: string,
  nodes: Array<{ nodeId: string; nodeType: string; title: string }>
): Promise<void> {
  if (nodes.length === 0) return
  await db
    .insert(automationRunSteps)
    .values(
      nodes.map((node) => ({
        runId,
        nodeId: node.nodeId,
        nodeType: node.nodeType,
        title: node.title,
        status: "pending" as AutomationStepStatus,
      }))
    )
    .onConflictDoNothing({
      target: [automationRunSteps.runId, automationRunSteps.nodeId],
    })
}

export async function upsertRunStep({
  runId,
  nodeId,
  nodeType,
  title,
  status,
  attempt,
  error,
  output,
  durationMs,
}: {
  runId: string
  nodeId: string
  nodeType: string
  title: string
  status: AutomationStepStatus
  attempt: number
  error?: string | null
  output?: unknown
  durationMs?: number
}): Promise<void> {
  const now = new Date()
  await db
    .insert(automationRunSteps)
    .values({
      runId,
      nodeId,
      nodeType,
      title,
      status,
      attempt,
      error: error ?? null,
      output: output ?? null,
      startedAt: status === "running" || status === "done" || status === "failed" ? now : null,
      finishedAt: status === "done" || status === "failed" || status === "skipped" ? now : null,
      durationMs: durationMs ?? null,
    })
    .onConflictDoUpdate({
      target: [automationRunSteps.runId, automationRunSteps.nodeId],
      set: {
        status,
        attempt,
        error: error ?? null,
        ...(output !== undefined ? { output } : {}),
        finishedAt:
          status === "done" || status === "failed" || status === "skipped" ? now : null,
        ...(durationMs !== undefined ? { durationMs } : {}),
        startedAt: sql`coalesce(${automationRunSteps.startedAt}, ${now})`,
      },
    })
}

/** Runs that were left mid-flight (worker restarted, deploy, crash) are marked
 *  failed when their timestamp is old, so the UI never shows a spinner forever. */
export async function reconcileStaleRuns(userId: string, workflowId: string): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000)
  await db
    .update(automationRuns)
    .set({
      status: "failed",
      error: "La ejecución se interrumpió antes de terminar.",
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(automationRuns.workflowId, workflowId),
        eq(automationRuns.userId, userId),
        sql`${automationRuns.status} in ('queued', 'running')`,
        sql`${automationRuns.startedAt} < ${cutoff}`
      )
    )
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export async function getScheduleFor(workflowId: string): Promise<AutomationSchedule | null> {
  const [row] = await db
    .select()
    .from(automationSchedules)
    .where(eq(automationSchedules.workflowId, workflowId))
  return row ?? null
}

export async function upsertScheduleRow({
  userId,
  workflowId,
  kind,
  cron,
  timezone,
  enabled,
  nextRunAt,
  triggerScheduleId,
}: {
  userId: string
  workflowId: string
  kind: "cron" | "once"
  cron?: string | null
  timezone: string
  enabled: boolean
  nextRunAt?: Date | null
  triggerScheduleId?: string | null
}): Promise<AutomationSchedule> {
  const [row] = await db
    .insert(automationSchedules)
    .values({
      userId,
      workflowId,
      kind,
      cron: cron ?? null,
      timezone,
      enabled,
      nextRunAt: nextRunAt ?? null,
      triggerScheduleId: triggerScheduleId ?? null,
    })
    .onConflictDoUpdate({
      target: automationSchedules.workflowId,
      set: {
        kind,
        cron: cron ?? null,
        timezone,
        enabled,
        nextRunAt: nextRunAt ?? null,
        ...(triggerScheduleId !== undefined ? { triggerScheduleId } : {}),
        updatedAt: new Date(),
      },
    })
    .returning()

  return row!
}

export async function deleteScheduleRow(workflowId: string): Promise<AutomationSchedule | null> {
  const [row] = await db
    .delete(automationSchedules)
    .where(eq(automationSchedules.workflowId, workflowId))
    .returning()
  return row ?? null
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export async function listApprovals({
  userId,
  workflowId,
}: {
  userId: string
  workflowId: string
}): Promise<AutomationApproval[]> {
  return db
    .select()
    .from(automationApprovals)
    .where(
      and(eq(automationApprovals.workflowId, workflowId), eq(automationApprovals.userId, userId))
    )
    .orderBy(desc(automationApprovals.grantedAt))
}

export async function createApproval({
  userId,
  workflowId,
  version,
  scopeHash,
  actions,
}: {
  userId: string
  workflowId: string
  version: number
  scopeHash: string
  actions: Array<{ nodeId: string; type: string; label: string }>
}): Promise<AutomationApproval> {
  const [row] = await db
    .insert(automationApprovals)
    .values({ userId, workflowId, version, scopeHash, actions })
    .returning()
  return row!
}

export async function revokeApprovals({
  userId,
  workflowId,
}: {
  userId: string
  workflowId: string
}): Promise<void> {
  await db
    .update(automationApprovals)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(automationApprovals.workflowId, workflowId),
        eq(automationApprovals.userId, userId),
        sql`${automationApprovals.revokedAt} is null`
      )
    )
}

export type RunViewRow = {
  id: string
  status: AutomationRunStatus
  origin: AutomationRunOrigin
  environment: "cloud" | "local" | "hybrid"
  version: number
  startedAt: string
  durationMs: number | null
  error: string | null
  steps: Array<{
    nodeId: string
    title: string
    nodeType: string
    status: AutomationStepStatus
    attempt: number
    error: string | null
    durationMs: number | null
  }>
}

/** Runs plus their steps, ready for the client (dates as ISO strings). */
export async function listRunViews({
  userId,
  workflowId,
  limit = 10,
}: {
  userId: string
  workflowId: string
  limit?: number
}): Promise<RunViewRow[]> {
  const runs = await listRuns({ userId, workflowId, limit })
  if (runs.length === 0) return []

  const steps = await db
    .select()
    .from(automationRunSteps)
    .where(
      inArray(
        automationRunSteps.runId,
        runs.map((run) => run.id)
      )
    )
    .orderBy(automationRunSteps.startedAt)

  const byRun = new Map<string, typeof steps>()
  for (const step of steps) {
    const list = byRun.get(step.runId) ?? []
    list.push(step)
    byRun.set(step.runId, list)
  }

  return runs.map((run) => ({
    id: run.id,
    status: run.status,
    origin: run.origin,
    environment: run.environment,
    version: run.version,
    startedAt: run.startedAt.toISOString(),
    durationMs: run.durationMs,
    error: run.error,
    steps: (byRun.get(run.id) ?? []).map((step) => ({
      nodeId: step.nodeId,
      title: step.title,
      nodeType: step.nodeType,
      status: step.status,
      attempt: step.attempt,
      error: step.error,
      durationMs: step.durationMs,
    })),
  }))
}

/** Everything the automation page needs, in one round trip. */
export async function getAutomationDetail(userId: string, id: string) {
  const automation = await getAutomation(userId, id)
  if (!automation) return null

  const [runs, schedule, approvals, versions] = await Promise.all([
    listRuns({ userId, workflowId: id, limit: 20 }),
    getScheduleFor(id),
    listApprovals({ userId, workflowId: id }),
    listVersions({ userId, workflowId: id }),
  ])

  return { automation, runs, schedule, approvals, versions }
}
