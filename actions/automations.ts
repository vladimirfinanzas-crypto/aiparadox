"use server"

import { randomUUID } from "node:crypto"
import * as Sentry from "@sentry/nextjs"
import { auth } from "@clerk/nextjs/server"
import { runs, tasks } from "@trigger.dev/sdk"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { automationScopeHash, approvalFor, canRunUnattended } from "@/lib/automations/approvals"
import { executionTargetOf } from "@/lib/automations/catalog"
import {
  emptyDefinition,
  parseDefinition,
  type AutomationDefinition,
  type AutomationTrigger,
} from "@/lib/automations/definition"
import { availableEnvNames } from "@/lib/automations/env"
import { pauseSchedule, removeSchedule, resumeSchedule, syncSchedule } from "@/lib/automations/schedule"
import { approvalActions, approvalSummary } from "@/lib/automations/summary"
import { proposeDefinition, automationSnapshot } from "@/lib/automations/tools"
import { validateDefinition, validateUnknown } from "@/lib/automations/validate"
import {
  attachTriggerRun,
  createApproval,
  createAutomation,
  createRun,
  deleteAutomation,
  finishRun,
  getAutomation,
  getRun,
  listApprovals,
  requireAutomation,
  revokeApprovals,
  saveAutomationDefinition,
  setAutomationStatus,
  updateAutomationMeta,
} from "@/queries/automations"

// Every action starts by taking the Clerk user from the session. The ids that
// arrive from the browser are only ever combined with that user id in the
// WHERE clause, so changing an id in devtools reaches nothing.

async function requireUserId(): Promise<string> {
  const { userId } = await auth()
  if (!userId) throw new Error("Unauthorized")
  return userId
}

export type ActionFailure = {
  ok: false
  errors: Array<{ code: string; message: string; nodeId?: string }>
}

function failure(message: string, code = "error"): ActionFailure {
  return { ok: false, errors: [{ code, message }] }
}

function revalidate(id?: string) {
  revalidatePath("/workflows")
  if (id) revalidatePath(`/workflows/${id}`)
}

// ---------------------------------------------------------------------------
// Creation and editing
// ---------------------------------------------------------------------------

export async function createAutomationAction(name?: string) {
  const userId = await requireUserId()

  const definition = emptyDefinition(name?.trim() || "Nueva automatización")
  const automation = await createAutomation({
    userId,
    name: definition.name,
    definition,
  })

  Sentry.logger.info("Automation created", { automationId: automation.id, userId })
  revalidate()

  return { ok: true as const, id: automation.id }
}

export async function createAndOpenAutomationAction() {
  const result = await createAutomationAction()
  redirect(`/workflows/${result.id}`)
}

export async function saveAutomationAction({
  id,
  definition,
}: {
  id: string
  definition: unknown
}) {
  const userId = await requireUserId()

  const parsed = validateUnknown(definition, { availableEnv: availableEnvNames() })
  if (!parsed.definition) {
    return { ok: false as const, errors: parsed.report.errors }
  }
  if (!parsed.report.ok) {
    return { ok: false as const, errors: parsed.report.errors }
  }

  try {
    const result = await saveAutomationDefinition({
      userId,
      id,
      definition: parsed.definition,
    })

    // Saving a change that alters what the flow does stops it from running on
    // its own until it is approved again: the schedule is paused with it.
    if (result.status === "pending_approval") {
      await pauseSchedule(id)
    }

    revalidate(id)

    return {
      ok: true as const,
      version: result.version,
      status: result.status,
      unchanged: result.unchanged,
      warnings: parsed.report.warnings,
      effects: parsed.report.effects,
    }
  } catch (error) {
    Sentry.logger.warn("Automation save failed", { automationId: id, userId })
    return failure(error instanceof Error ? error.message : "No se pudo guardar.")
  }
}

export async function validateAutomationAction({ id }: { id: string }) {
  const userId = await requireUserId()
  const automation = await getAutomation(userId, id)
  if (!automation) return failure("Esa automatización no existe en tu cuenta.")

  const definition = automation.definition ?? emptyDefinition(automation.name, automation.timezone)
  const report = validateDefinition(definition, { availableEnv: availableEnvNames() })

  return {
    ok: report.ok as boolean,
    errors: report.errors,
    warnings: report.warnings,
    effects: report.effects,
    version: automation.version,
  }
}

export async function renameAutomationAction({
  id,
  name,
  description,
}: {
  id: string
  name?: string
  description?: string | null
}) {
  const userId = await requireUserId()
  const trimmed = name?.trim()
  if (trimmed !== undefined && trimmed.length === 0) {
    return failure("Ponle un nombre a la automatización.")
  }

  const automation = await updateAutomationMeta({
    userId,
    id,
    ...(trimmed ? { name: trimmed } : {}),
    ...(description !== undefined ? { description } : {}),
  })

  revalidate(id)
  return { ok: true as const, name: automation.name }
}

export async function updateTriggerAction({
  id,
  trigger,
}: {
  id: string
  trigger: AutomationTrigger
}) {
  const userId = await requireUserId()
  const automation = await requireAutomation(userId, id)
  const definition = automation.definition ?? emptyDefinition(automation.name, automation.timezone)

  const next: AutomationDefinition = { ...definition, trigger, name: definition.name }
  const parsed = parseDefinition(next)
  if (!parsed.ok) return failure(parsed.issues[0] ?? "Frecuencia inválida.")

  const report = validateDefinition(parsed.definition, { availableEnv: availableEnvNames() })
  if (!report.ok) {
    return { ok: false as const, errors: report.errors }
  }

  const saved = await saveAutomationDefinition({ userId, id, definition: parsed.definition })

  // An active flow reschedules immediately; a draft just stores the rule.
  if (saved.status === "active") {
    const sync = await syncSchedule({
      userId,
      workflowId: id,
      version: saved.version,
      definition: parsed.definition,
    })
    await setAutomationStatus({
      userId,
      id,
      status: "active",
      nextRunAt: sync.nextRunAt,
    })
  } else {
    await pauseSchedule(id).catch(() => undefined)
  }

  revalidate(id)
  return { ok: true as const, version: saved.version, status: saved.status }
}

export async function deleteAutomationAction(id: string) {
  const userId = await requireUserId()

  await removeSchedule(id).catch(() => undefined)
  const deleted = await deleteAutomation(userId, id)
  if (!deleted) return failure("Esa automatización no existe en tu cuenta.")

  Sentry.logger.info("Automation deleted", { automationId: id, userId })
  revalidate()
  return { ok: true as const }
}

// ---------------------------------------------------------------------------
// Approval and activation
// ---------------------------------------------------------------------------

/** Everything the person is about to approve, so the dialog can show it. */
export async function previewApprovalAction({ id }: { id: string }) {
  const userId = await requireUserId()
  const automation = await requireAutomation(userId, id)
  const definition = automation.definition ?? emptyDefinition(automation.name, automation.timezone)

  const report = validateDefinition(definition, { availableEnv: availableEnvNames() })

  return {
    ok: report.ok as boolean,
    version: automation.version,
    summary: approvalSummary(definition),
    errors: report.errors,
    warnings: report.warnings,
    alreadyApproved: Boolean(
      approvalFor(await listApprovals({ userId, workflowId: id }), definition, {
        version: automation.version,
      })
    ),
  }
}

export async function approveAndActivateAction({ id }: { id: string }) {
  const userId = await requireUserId()
  const automation = await requireAutomation(userId, id)
  const definition = automation.definition ?? emptyDefinition(automation.name, automation.timezone)

  const report = validateDefinition(definition, { availableEnv: availableEnvNames() })
  if (!report.ok) {
    return { ok: false as const, errors: report.errors }
  }

  if (definition.trigger.kind !== "manual" && report.effects.length > 0) {
    // Activation is the moment the person takes responsibility for the effects.
    // A flow with no external effects needs no approval record: there is
    // nothing it can do outside Paradox without a person watching.
    await createApproval({
      userId,
      workflowId: id,
      version: automation.version,
      scopeHash: automationScopeHash(definition),
      actions: approvalActions(definition).map((action) => ({
        nodeId: action.nodeId,
        type: action.type,
        label: action.label,
      })),
    })
  }

  let nextRunAt: Date | null = null
  try {
    const sync = await syncSchedule({
      userId,
      workflowId: id,
      version: automation.version,
      definition,
    })
    nextRunAt = sync.nextRunAt
  } catch (error) {
    Sentry.logger.error("Schedule creation failed", {
      automationId: id,
      userId,
      message: error instanceof Error ? error.message : "unknown",
    })
    return failure(
      `No se pudo programar la automatización: ${
        error instanceof Error ? error.message : "el servicio de ejecución no respondió"
      }`
    )
  }

  const updated = await setAutomationStatus({
    userId,
    id,
    status: "active",
    activatedAt: new Date(),
    nextRunAt,
  })

  Sentry.logger.info("Automation activated", { automationId: id, userId })
  revalidate(id)
  return { ok: true as const, status: updated.status, nextRunAt }
}

export async function pauseAutomationAction({
  id,
}: {
  id: string
}): Promise<{ ok: true } | ActionFailure> {
  const userId = await requireUserId()
  const automation = await getAutomation(userId, id)
  if (!automation) return failure("Esa automatización no existe en tu cuenta.")

  await pauseSchedule(id)
  await setAutomationStatus({ userId, id, status: "paused", nextRunAt: null })

  revalidate(id)
  return { ok: true as const }
}

export async function resumeAutomationAction({ id }: { id: string }) {
  const userId = await requireUserId()
  const automation = await requireAutomation(userId, id)
  const definition = automation.definition ?? emptyDefinition(automation.name, automation.timezone)

  // Resuming is not approving: an edited flow needs a fresh look first.
  const gate = canRunUnattended({
    definition,
    version: automation.version,
    approvals: await listApprovals({ userId, workflowId: id }),
    status: "active",
  })
  if (!gate.ok) {
    return failure(gate.reason, "approval-required")
  }

  const nextRunAt = await resumeSchedule(id).catch(() => null)
  await setAutomationStatus({ userId, id, status: "active", nextRunAt })

  revalidate(id)
  return { ok: true as const, nextRunAt }
}

export async function deactivateAutomationAction({
  id,
}: {
  id: string
}): Promise<{ ok: true } | ActionFailure> {
  const userId = await requireUserId()
  const automation = await getAutomation(userId, id)
  if (!automation) return failure("Esa automatización no existe en tu cuenta.")

  await removeSchedule(id)
  await revokeApprovals({ userId, workflowId: id })
  await setAutomationStatus({ userId, id, status: "draft", nextRunAt: null })

  revalidate(id)
  return { ok: true as const }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export async function runAutomationAction({
  id,
  definition,
}: {
  id: string
  /** The canvas may be ahead of the database; saving first keeps one truth. */
  definition?: unknown
}): Promise<
  | { ok: true; runId: string; version: number }
  | ActionFailure
> {
  const userId = await requireUserId()
  const automation = await requireAutomation(userId, id)

  let active = automation
  if (definition !== undefined) {
    const parsed = validateUnknown(definition, { availableEnv: availableEnvNames() })
    if (!parsed.definition || !parsed.report.ok) {
      return { ok: false as const, errors: parsed.report.errors }
    }

    const saved = await saveAutomationDefinition({
      userId,
      id,
      definition: parsed.definition,
    })
    active = saved.automation
    if (saved.status === "pending_approval") await pauseSchedule(id).catch(() => undefined)
  }

  const currentDefinition =
    active.definition ?? emptyDefinition(active.name, active.timezone)
  const report = validateDefinition(currentDefinition, { availableEnv: availableEnvNames() })
  if (!report.ok) return { ok: false as const, errors: report.errors }

  const run = await createRun({
    userId,
    workflowId: id,
    version: active.version,
    origin: "manual",
    environment: executionTargetOf(currentDefinition.nodes),
    // A manual run is a new run every time: the person pressed the button.
    idempotencyKey: `manual:${id}:${randomUUID()}`,
  })

  try {
    const handle = await tasks.trigger("run-automation", { runId: run.id })
    await attachTriggerRun(run.id, handle.id)
  } catch (error) {
    await finishRun({
      runId: run.id,
      status: "failed",
      error: "No se pudo iniciar la ejecución (¿está el worker de Trigger.dev en marcha?).",
    })
    return failure(
      `No se pudo iniciar la ejecución: ${
        error instanceof Error ? error.message : "el servicio de ejecución no respondió"
      }`
    )
  }

  Sentry.logger.info("Automation run started", { automationId: id, userId, runId: run.id })
  revalidate(id)
  return { ok: true as const, runId: run.id, version: active.version }
}

export async function cancelRunAction({ runId }: { runId: string }) {
  const userId = await requireUserId()
  const found = await getRun({ userId, runId })
  if (!found) return failure("Esa ejecución no existe en tu cuenta.")

  if (found.run.triggerRunId) {
    await runs.cancel(found.run.triggerRunId).catch(() => undefined)
  }

  await finishRun({
    runId,
    status: "cancelled",
    error: "Cancelada por la persona.",
  })

  revalidate(found.run.workflowId)
  return { ok: true as const }
}

export async function retryRunAction({ runId }: { runId: string }) {
  const userId = await requireUserId()
  const found = await getRun({ userId, runId })
  if (!found) return failure("Esa ejecución no existe en tu cuenta.")

  const automation = await requireAutomation(userId, found.run.workflowId)
  const definition = automation.definition ?? emptyDefinition(automation.name, automation.timezone)

  const run = await createRun({
    userId,
    workflowId: automation.id,
    version: automation.version,
    origin: "manual",
    environment: executionTargetOf(definition.nodes),
    idempotencyKey: `retry:${runId}:${randomUUID()}`,
  })

  const handle = await tasks.trigger("run-automation", { runId: run.id })
  await attachTriggerRun(run.id, handle.id)

  revalidate(automation.id)
  return { ok: true as const, runId: run.id }
}

// ---------------------------------------------------------------------------
// Godfather, inside Automations
// ---------------------------------------------------------------------------

export async function godfatherProposalAction({
  id,
  instruction,
  history = [],
}: {
  id: string
  instruction: string
  history?: Array<{ role: "user" | "assistant"; text: string }>
}) {
  const userId = await requireUserId()
  const snapshot = await automationSnapshot(userId, id)
  if (!snapshot) return failure("Esa automatización no existe en tu cuenta.")

  const text = instruction.trim()
  if (!text) return failure("Dime qué quieres que haga la automatización.")

  try {
    const proposal = await proposeDefinition({
      instruction: text,
      current: snapshot.definition,
      timezone: snapshot.definition.trigger.timezone,
      history,
    })

    if (!proposal.ok || !proposal.definition) {
      return {
        ok: false as const,
        errors: proposal.issues,
        message: proposal.message,
      }
    }

    return {
      ok: true as const,
      message: proposal.message,
      definition: proposal.definition,
      summary: approvalSummary(proposal.definition),
    }
  } catch (error) {
    Sentry.logger.warn("Godfather proposal failed", { automationId: id, userId })
    return failure(
      `Godfather no pudo responder: ${
        error instanceof Error ? error.message : "el modelo no está disponible"
      }`
    )
  }
}

/** Apply a proposal the person accepted. Versioned, validated, and never
 *  activated by this call. */
export async function applyGodfatherProposalAction({
  id,
  definition,
}: {
  id: string
  definition: unknown
}) {
  const userId = await requireUserId()
  const parsed = parseDefinition(definition)
  if (!parsed.ok) return failure(parsed.issues[0] ?? "Definición inválida.")

  try {
    const result = await saveAutomationDefinition({
      userId,
      id,
      definition: parsed.definition,
      author: "godfather",
    })
    if (result.status === "pending_approval") await pauseSchedule(id).catch(() => undefined)

    revalidate(id)
    return { ok: true as const, version: result.version, status: result.status }
  } catch (error) {
    return failure(error instanceof Error ? error.message : "No se pudo guardar el borrador.")
  }
}
