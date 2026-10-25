import { describe, expect, it } from "vitest"

// Live View against the real database: the feed is derived from rows the rest of
// the product already writes, so this test writes those rows and checks what the
// panel would receive — including that one account never sees another's tasks.
const hasDatabase = (() => {
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file)
    } catch {
      // A missing file is fine: the value may come from the shell
    }
  }
  return Boolean(process.env.DATABASE_URL)
})()

const USER_A = "__live_test_a__"
const USER_B = "__live_test_b__"

describe.skipIf(!hasDatabase)(
  "live feed against the real database",
  { timeout: 30_000 },
  () => {
    const cleanup = async () => {
      const { db } = await import("@/db")
      const { workflows, desktopDevices, pcJobs, executionTasks, executions } =
        await import("@/db/schema")
      const { inArray } = await import("drizzle-orm")

      // Runs and steps hang off the workflow (cascade)
      await db.delete(workflows).where(inArray(workflows.userId, [USER_A, USER_B]))
      await db.delete(pcJobs).where(inArray(pcJobs.userId, [USER_A, USER_B]))
      await db
        .delete(executionTasks)
        .where(inArray(executionTasks.userId, [USER_A, USER_B]))
      await db.delete(executions).where(inArray(executions.userId, [USER_A, USER_B]))
      await db
        .delete(desktopDevices)
        .where(inArray(desktopDevices.userId, [USER_A, USER_B]))
    }

    it("projects real runs, steps, approvals, local jobs and tool calls", async () => {
      const { getLiveFeed } = await import("@/queries/live")
      const { db } = await import("@/db")
      const {
        automationRunSteps,
        automationRuns,
        desktopDevices,
        executionTasks,
        executions,
        pcJobs,
        workflows,
      } = await import("@/db/schema")

      await cleanup()

      const [workflow] = await db
        .insert(workflows)
        .values({
          userId: USER_A,
          name: "Informe semanal",
          status: "pending_approval",
          version: 3,
        })
        .returning()

      const [run] = await db
        .insert(automationRuns)
        .values({
          workflowId: workflow!.id,
          userId: USER_A,
          version: 3,
          status: "running",
          origin: "schedule",
          environment: "cloud",
        })
        .returning()

      // The engine seeds one step per planned block, so this is real progress
      await db.insert(automationRunSteps).values([
        { runId: run!.id, nodeId: "start", nodeType: "start", title: "Inicio", status: "done" },
        { runId: run!.id, nodeId: "read", nodeType: "http", title: "Leer", status: "done" },
        { runId: run!.id, nodeId: "send", nodeType: "email", title: "Enviar", status: "running" },
      ])

      await db.insert(executionTasks).values({
        userId: USER_A,
        request: "Entra en el portal y descarga la factura",
        status: "awaiting_execution_environment",
        events: [],
      })

      await db.insert(pcJobs).values({
        userId: USER_A,
        action: { kind: "screenshot" },
        status: "pending",
      })

      await db.insert(executions).values({
        userId: USER_A,
        role: "tool",
        prompt: 'panel_create {"name":"Gastos"}',
        status: "completed",
        result: '{"id":"w_test","path":"/widgets/w_test","blocks":2}',
        completedAt: new Date(),
      })

      await db.insert(desktopDevices).values({
        userId: USER_A,
        name: "Portátil de prueba",
        tokenHash: "__live_test_token__",
        status: "online",
        lastSeenAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      })

      // Another account, with its own work
      const [otherWorkflow] = await db
        .insert(workflows)
        .values({ userId: USER_B, name: "Ajena", status: "active", version: 1 })
        .returning()

      await db.insert(automationRuns).values({
        workflowId: otherWorkflow!.id,
        userId: USER_B,
        status: "running",
        origin: "manual",
      })

      const feed = await getLiveFeed(USER_A)
      const ids = feed.items.map((entry) => entry.id)

      // The run carries progress computed from its own steps
      const runItem = feed.items.find((entry) => entry.id === `run-${run!.id}`)
      expect(runItem).toBeDefined()
      expect(runItem?.status).toBe("running")
      expect(runItem?.progress).toEqual({ done: 2, total: 3 })
      expect(runItem?.href).toBe(`/workflows/${workflow!.id}`)

      // A flow waiting for the person is an attention item, not a run
      expect(feed.items.some((entry) => entry.id === `approval-${workflow!.id}`)).toBe(
        true
      )
      expect(feed.counts.attention).toBeGreaterThanOrEqual(2)

      // Browser/desktop orchestration, local queue and worked resources
      expect(ids.some((id) => id.startsWith("task-"))).toBe(true)
      expect(ids.some((id) => id.startsWith("job-"))).toBe(true)

      const created = feed.items.find((entry) => entry.id.startsWith("tool-"))
      expect(created?.source).toBe("workspace")
      expect(created?.href).toBe("/widgets/w_test")

      // A device that stopped reporting is offline, and the panel can say so
      expect(feed.devices).toEqual({ total: 1, online: 0 })

      // Everything is scoped: the other account's run is absent
      const otherFeed = await getLiveFeed(USER_B)
      expect(otherFeed.items.some((entry) => entry.id === `run-${run!.id}`)).toBe(false)
      expect(
        otherFeed.items.some((entry) => entry.id === `approval-${workflow!.id}`)
      ).toBe(false)
      expect(otherFeed.devices).toEqual({ total: 0, online: 0 })
      expect(otherFeed.items).toHaveLength(1)

      await cleanup()
    })

    it("shows a finished run as done and a blocked one as needing approval", async () => {
      const { getLiveFeed } = await import("@/queries/live")
      const { db } = await import("@/db")
      const { automationRuns, workflows } = await import("@/db/schema")

      await cleanup()

      const [workflow] = await db
        .insert(workflows)
        .values({ userId: USER_A, name: "Cobros", status: "active", version: 2 })
        .returning()

      await db.insert(automationRuns).values([
        {
          workflowId: workflow!.id,
          userId: USER_A,
          status: "blocked",
          origin: "godfather",
          error: "Falta la aprobación de la versión 2",
        },
        {
          workflowId: workflow!.id,
          userId: USER_A,
          status: "succeeded",
          origin: "manual",
          finishedAt: new Date(),
          durationMs: 1200,
        },
      ])

      const feed = await getLiveFeed(USER_A)
      const blocked = feed.items.find((entry) => entry.statusLabel === "Espera tu aprobación")
      const done = feed.items.find((entry) => entry.status === "succeeded")

      expect(blocked).toBeDefined()
      expect(blocked?.status).toBe("attention")
      expect(done).toBeDefined()
      expect(done?.statusLabel).toBe("Completada")
      // A finished run reports no progress bar
      expect(done?.progress).toBeUndefined()

      await cleanup()
    })
  }
)
