import { schedules, tasks } from "@trigger.dev/sdk"

import {
  createRun,
  deleteScheduleRow,
  getScheduleFor,
  upsertScheduleRow,
} from "@/queries/automations"
import { executionTargetOf } from "@/lib/automations/catalog"
import type { AutomationDefinition } from "@/lib/automations/definition"

// Scheduling lives in Trigger.dev, which is durable: it fires whether the
// person's browser is open, closed, or on another machine. This module keeps
// the row that the UI reads in step with the scheduler, and nothing else is
// allowed to create a schedule.

const FIRE_TASK = "fire-automation"

export type ScheduleSyncResult = {
  kind: "manual" | "cron" | "once"
  triggerScheduleId: string | null
  nextRunAt: Date | null
}

/** The schedule this definition asks for. */
export function wantsSchedule(definition: AutomationDefinition): ScheduleSyncResult["kind"] {
  return definition.trigger.kind
}

export async function syncSchedule({
  userId,
  workflowId,
  version,
  definition,
}: {
  userId: string
  workflowId: string
  /** The definition version these runs will execute. */
  version: number
  definition: AutomationDefinition
}): Promise<ScheduleSyncResult> {
  const existing = await getScheduleFor(workflowId)

  // Manual flows have no schedule at all: any previous one is removed so an
  // old cron cannot keep waking a flow the person turned into a manual one.
  if (definition.trigger.kind === "manual") {
    if (existing?.triggerScheduleId) {
      await schedules.del(existing.triggerScheduleId).catch(() => undefined)
    }
    if (existing) await deleteScheduleRow(workflowId)
    return { kind: "manual", triggerScheduleId: null, nextRunAt: null }
  }

  if (definition.trigger.kind === "cron") {
    const cron = definition.trigger.cron ?? ""
    const timezone = definition.trigger.timezone || "UTC"

    const schedule = existing?.triggerScheduleId
      ? await schedules.update(existing.triggerScheduleId, {
          task: FIRE_TASK,
          cron,
          timezone,
          externalId: workflowId,
        })
      : await schedules.create({
          task: FIRE_TASK,
          cron,
          timezone,
          externalId: workflowId,
          // One durable schedule per automation, whatever happens to the row.
          deduplicationKey: `automation:${workflowId}`,
        })

    const nextRunAt = schedule.nextRun ? new Date(schedule.nextRun) : null

    await upsertScheduleRow({
      userId,
      workflowId,
      kind: "cron",
      cron,
      timezone,
      enabled: true,
      nextRunAt,
      triggerScheduleId: schedule.id,
    })

    return { kind: "cron", triggerScheduleId: schedule.id, nextRunAt }
  }

  // One-off: a delayed run, exactly once. No cron row to maintain, and the
  // previous schedule (if the flow used to be recurrent) is removed.
  if (existing?.triggerScheduleId) {
    await schedules.del(existing.triggerScheduleId).catch(() => undefined)
  }

  const runAt = definition.trigger.runAt ? new Date(definition.trigger.runAt) : null
  if (!runAt || Number.isNaN(runAt.getTime()) || runAt.getTime() <= Date.now()) {
    await upsertScheduleRow({
      userId,
      workflowId,
      kind: "once",
      cron: null,
      timezone: definition.trigger.timezone || "UTC",
      enabled: false,
      nextRunAt: null,
      triggerScheduleId: null,
    })
    return { kind: "once", triggerScheduleId: null, nextRunAt: null }
  }

  // The run row exists before the delay, so it is visible in the history as
  // "queued" and the trigger carries only its id.
  const run = await createRun({
    userId,
    workflowId,
    version,
    origin: "schedule",
    environment: executionTargetOf(definition.nodes),
    idempotencyKey: `once:${workflowId}:${runAt.toISOString()}`,
  })

  await tasks.trigger("run-automation", { runId: run.id }, { delay: runAt })

  await upsertScheduleRow({
    userId,
    workflowId,
    kind: "once",
    cron: null,
    timezone: definition.trigger.timezone || "UTC",
    enabled: true,
    nextRunAt: runAt,
    triggerScheduleId: null,
  })

  return { kind: "once", triggerScheduleId: null, nextRunAt: runAt }
}

/** Stop firing without losing the rule, so resuming is one click. */
export async function pauseSchedule(workflowId: string): Promise<void> {
  const existing = await getScheduleFor(workflowId)
  if (!existing) return

  if (existing.triggerScheduleId) {
    // Deactivate rather than delete: the cron expression and its history stay.
    await schedules.deactivate(existing.triggerScheduleId).catch(() => undefined)
  }

  await upsertScheduleRow({
    userId: existing.userId,
    workflowId,
    kind: existing.kind,
    cron: existing.cron,
    timezone: existing.timezone,
    enabled: false,
    nextRunAt: null,
    triggerScheduleId: existing.triggerScheduleId,
  })
}

export async function resumeSchedule(workflowId: string): Promise<Date | null> {
  const existing = await getScheduleFor(workflowId)
  if (!existing || !existing.triggerScheduleId) return null

  const schedule = await schedules.activate(existing.triggerScheduleId)
  const nextRunAt = schedule.nextRun ? new Date(schedule.nextRun) : null

  await upsertScheduleRow({
    userId: existing.userId,
    workflowId,
    kind: existing.kind,
    cron: existing.cron,
    timezone: existing.timezone,
    enabled: true,
    nextRunAt,
    triggerScheduleId: existing.triggerScheduleId,
  })

  return nextRunAt
}

export async function removeSchedule(workflowId: string): Promise<void> {
  const existing = await getScheduleFor(workflowId)
  if (!existing) return

  if (existing.triggerScheduleId) {
    await schedules.del(existing.triggerScheduleId).catch(() => undefined)
  }
  await deleteScheduleRow(workflowId)
}
