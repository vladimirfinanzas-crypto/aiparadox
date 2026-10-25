import { logger, schedules, tasks } from "@trigger.dev/sdk"

import { db } from "@/db"
import { workflows } from "@/db/schema"
import { eq } from "drizzle-orm"
import { canRunUnattended } from "@/lib/automations/approvals"
import { executionTargetOf } from "@/lib/automations/catalog"
import { parseDefinition } from "@/lib/automations/definition"
import {
  createRun,
  finishRun,
  getScheduleFor,
  listApprovals,
  upsertScheduleRow,
} from "@/queries/automations"

// The bridge between the durable scheduler and the runner.
//
// Trigger.dev fires this task on the automation's cron. The task re-checks the
// automation's own state before doing anything: a flow that was paused, or whose
// definition changed after it was approved, must not run on its own. When it
// refuses, it records *why* as a blocked run, so the person sees it in the
// history instead of wondering why nothing happened.

export const fireAutomationTask = schedules.task({
  id: "fire-automation",
  maxDuration: 120,
  run: async (payload) => {
    const workflowId = payload.externalId
    if (!workflowId) {
      logger.warn("fire-automation without externalId", { scheduleId: payload.scheduleId })
      return { status: "skipped" as const, reason: "no-automation" }
    }

    const [automation] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId))

    if (!automation) {
      logger.warn("Scheduled automation no longer exists", { workflowId })
      return { status: "skipped" as const, reason: "missing" }
    }

    // Keep the row's next run honest: the schedule can outlive a page view.
    await getScheduleFor(workflowId).then((row) =>
      row
        ? upsertScheduleRow({
            userId: row.userId,
            workflowId,
            kind: row.kind,
            cron: row.cron,
            timezone: row.timezone,
            enabled: row.enabled,
            nextRunAt: payload.upcoming[0] ?? null,
            triggerScheduleId: row.triggerScheduleId,
          })
        : undefined
    )

    if (automation.status !== "active") {
      logger.log("Scheduled fire skipped: automation not active", {
        workflowId,
        status: automation.status,
      })
      return { status: "skipped" as const, reason: `status:${automation.status}` }
    }

    const parsed = parseDefinition(automation.definition)
    if (!parsed.ok) {
      logger.error("Scheduled fire skipped: invalid definition", { workflowId })
      return { status: "skipped" as const, reason: "invalid-definition" }
    }

    const definition = parsed.definition
    const approvals = await listApprovals({ userId: automation.userId, workflowId })
    const gate = canRunUnattended({
      definition,
      version: automation.version,
      approvals,
      status: automation.status,
    })

    // One run per scheduled instant, even if Trigger retries the delivery.
    const stamp = payload.timestamp.toISOString()
    const idempotencyKey = `schedule:${workflowId}:${stamp}`

    if (!gate.ok) {
      const blocked = await createRun({
        userId: automation.userId,
        workflowId,
        version: automation.version,
        origin: "schedule",
        environment: executionTargetOf(definition.nodes),
        idempotencyKey: `${idempotencyKey}:blocked`,
      })

      if (blocked.status === "queued") {
        await finishRun({
          runId: blocked.id,
          status: "blocked",
          error: gate.reason,
        })
      }

      logger.warn("Scheduled run blocked", { workflowId, reason: gate.reason })
      return { status: "blocked" as const, reason: gate.reason }
    }

    const run = await createRun({
      userId: automation.userId,
      workflowId,
      version: automation.version,
      origin: "schedule",
      environment: executionTargetOf(definition.nodes),
      idempotencyKey,
    })

    // A duplicate delivery already produced this run: do not start it twice.
    if (run.status !== "queued") {
      logger.log("Scheduled run already started", { runId: run.id, status: run.status })
      return { status: "skipped" as const, reason: "duplicate" }
    }

    await tasks.trigger("run-automation", { runId: run.id })

    logger.log("Scheduled run started", { workflowId, runId: run.id, scheduledFor: stamp })
    return { status: "started" as const, runId: run.id }
  },
})
