import { Stagehand } from "@browserbasehq/stagehand"
import { logger, metadata, task, wait } from "@trigger.dev/sdk"
import { and, eq } from "drizzle-orm"

import { db } from "@/db"
import { automationRuns, automationVersions, workflows } from "@/db/schema"
import { nodeExecutors } from "@/features/workflows/nodes/node-executors"
import { runAutomation, type EngineExecutor } from "@/lib/automations/engine"
import { parseDefinition } from "@/lib/automations/definition"
import { executionTargetOf } from "@/lib/automations/catalog"
import {
  attachTriggerRun,
  finishRun,
  markAutomationRun,
  markRunRunning,
  seedRunSteps,
  upsertRunStep,
} from "@/queries/automations"

// The runner. It owns nothing about branching: the engine decides what runs and
// in which order, and this task is the part that touches the world — a browser
// session, the person's computer, the database.
//
// One run = one row in `automation_runs` and one row per block in
// `automation_run_steps`, written as the run progresses. The console and the
// history read those rows, so a run survives a reload, a redeploy or a closed
// tab, and a cancelled run leaves evidence behind.

export type RunAutomationPayload = {
  runId: string
}

export const runAutomationTask = task({
  id: "run-automation",
  maxDuration: 3600,
  // Retries are per step (see `settings.retries`): retrying the whole run would
  // repeat emails and posts that already went out.
  retry: { maxAttempts: 1 },
  run: async ({ runId }: RunAutomationPayload, { ctx }) => {
    const [run] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, runId))

    if (!run) throw new Error(`Run ${runId} no existe.`)

    // The owner on the run row is what scopes every write below; it is never
    // taken from the payload.
    const [automation] = await db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, run.workflowId), eq(workflows.userId, run.userId)))

    if (!automation) {
      await finishRun({
        runId,
        status: "failed",
        error: "La automatización ya no existe.",
      })
      return { status: "failed" as const }
    }

    // The definition is the version that was queued, frozen at enqueue time: a
    // later edit cannot change what this run does half way through.
    const [frozen] = await db
      .select({ definition: automationVersions.definition })
      .from(automationVersions)
      .where(
        and(
          eq(automationVersions.workflowId, run.workflowId),
          eq(automationVersions.userId, run.userId),
          eq(automationVersions.version, run.version)
        )
      )

    const parsed = parseDefinition(frozen?.definition ?? automation.definition)
    if (!parsed.ok) {
      await finishRun({
        runId,
        status: "failed",
        error: `La definición guardada no es válida: ${parsed.issues[0] ?? "error de esquema"}`,
      })
      return { status: "failed" as const }
    }

    const definition = parsed.definition
    const environment = executionTargetOf(definition.nodes)

    if (run.status === "cancelled" || run.status === "succeeded" || run.status === "failed") {
      logger.log("Run already finished, nothing to do", { runId, status: run.status })
      return { status: run.status }
    }

    await attachTriggerRun(runId, ctx.run.id).catch(() => undefined)
    await markRunRunning(runId)
    await markAutomationRun({ userId: run.userId, id: run.workflowId, at: new Date() })

    metadata.set("automation", {
      runId,
      workflowId: run.workflowId,
      version: run.version,
      environment,
      blocks: definition.nodes.length,
    })

    // One Browserbase session per run, opened on the first block that needs it
    // and reused afterwards, so the recording covers the whole flow.
    let stagehand: Stagehand | undefined
    let browserbaseSessionId: string | undefined

    const getStagehand = async () => {
      if (stagehand) return stagehand
      stagehand = new Stagehand({
        env: "BROWSERBASE",
        apiKey: process.env.BROWSERBASE_API_KEY!,
        model: "google/gemini-2.5-flash",
        // Pino's thread-stream worker cannot be resolved inside the bundled
        // worker output, so it is disabled here for the same reason as in chat.
        disablePino: true,
      })
      await stagehand.init()
      browserbaseSessionId = stagehand.browserbaseSessionID
      return stagehand
    }

    const executors: Record<string, EngineExecutor> = Object.fromEntries(
      Object.entries(nodeExecutors).map(([type, executor]) => [
        type,
        (async ({ values }: { values: Record<string, string> }) =>
          executor({ values, getStagehand, userId: run.userId })) as EngineExecutor,
      ])
    )

    try {
      const result = await runAutomation({
        definition,
        executors,
        hooks: {
          onPlan: async (steps) => {
            await seedRunSteps(
              runId,
              steps.map((step) => ({
                nodeId: step.nodeId,
                nodeType: step.type,
                title: step.title,
              }))
            )
          },
          onStep: async (step) => {
            await upsertRunStep({
              runId,
              nodeId: step.nodeId,
              nodeType: step.type,
              title: step.title,
              status: step.status,
              attempt: step.attempt,
              error: step.error ?? null,
              ...(step.output !== undefined ? { output: step.output } : {}),
              ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
            })
          },
          // A durable wait: the worker can be evicted and the run resumes here.
          wait: async (ms) => {
            await wait.for({ seconds: Math.max(1, Math.round(ms / 1000)) })
          },
        },
      })

      await finishRun({
        runId,
        status: result.status === "succeeded" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed",
        ...(result.error ? { error: result.error } : {}),
        durationMs: result.durationMs,
        environment,
        output: {
          blocks: result.steps.length,
          ...(browserbaseSessionId ? { browserbaseSessionId } : {}),
          // What each step produced is already in its own row; this is the
          // summary the list view shows without loading the steps.
          steps: result.steps.map((step) => ({
            nodeId: step.nodeId,
            status: step.status,
            durationMs: step.durationMs ?? null,
          })),
        },
      })

      logger.log("Automation finished", {
        runId,
        workflowId: run.workflowId,
        status: result.status,
        durationMs: result.durationMs,
        blocks: definition.nodes.length,
      })

      return { status: result.status }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await finishRun({
        runId,
        status: "failed",
        error: message.slice(0, 2_000),
        environment,
      })
      logger.error("Automation crashed", { runId, message })
      throw error
    } finally {
      await stagehand?.close().catch(() => undefined)
    }
  },
})
