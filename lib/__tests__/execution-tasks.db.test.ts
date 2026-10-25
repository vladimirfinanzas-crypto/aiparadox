import { describe, expect, it } from "vitest"

// Integration check for the execution-task lifecycle against the real database.
// It runs only where a database is configured (`.env`) and the migration has
// been applied, so `npm test` stays green in a clean checkout: without
// DATABASE_URL the suite is skipped, not faked.
const hasDatabase = (() => {
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file)
    } catch {
      // A missing file is fine; the value may come from the shell
    }
  }
  return Boolean(process.env.DATABASE_URL)
})()

const TEST_USER = "__execution_task_test__"
const OTHER_USER = "__execution_task_test_other__"

const BOTH = {
  cloud: { available: true },
  local: { available: true },
}

describe.skipIf(!hasDatabase)(
  "execution tasks against the real database",
  { timeout: 20_000 },
  () => {
    it("keeps one pending question and answers it exactly once", async () => {
      const { db } = await import("@/db")
      const { executionTasks } = await import("@/db/schema")
      const { eq, inArray } = await import("drizzle-orm")
      const {
        activeExecutionTask,
        ensureAwaitingExecutionTask,
        respondToExecutionEnvironment,
      } = await import("@/lib/execution-tasks")

      await db
        .delete(executionTasks)
        .where(inArray(executionTasks.userId, [TEST_USER, OTHER_USER]))

      const first = await ensureAwaitingExecutionTask({
        userId: TEST_USER,
        conversationId: "chat-test-1",
        request: "Investiga los precios de 30 competidores",
        availability: BOTH,
      })
      const second = await ensureAwaitingExecutionTask({
        userId: TEST_USER,
        conversationId: "chat-test-1",
        request: "Investiga los precios de 30 competidores y haz una tabla",
        availability: BOTH,
      })

      expect(second.id).toBe(first.id)
      expect(first.status).toBe("awaiting_execution_environment")
      expect(first.options?.map((option) => option.id)).toEqual([
        "cloud",
        "local",
        "cancel",
      ])

      // Nobody is browsing while the question is open
      expect(await activeExecutionTask("chat-test-1", TEST_USER)).toBeNull()

      // A stranger's click must not resolve it
      const stranger = await respondToExecutionEnvironment({
        taskId: first.id,
        requesterId: OTHER_USER,
        choice: "cloud",
        availability: BOTH,
      })
      expect(stranger.kind).toBe("rejected")
      if (stranger.kind === "rejected") expect(stranger.code).toBe("not_owner")

      const chosen = await respondToExecutionEnvironment({
        taskId: first.id,
        requesterId: TEST_USER,
        choice: "cloud",
        availability: BOTH,
      })
      expect(chosen.kind).toBe("selected")
      if (chosen.kind !== "selected") return
      expect(chosen.environment).toBe("cloud")
      expect(chosen.duplicate).toBe(false)

      const active = await activeExecutionTask("chat-test-1", TEST_USER)
      expect(active?.id).toBe(first.id)
      expect(active?.environment).toBe("cloud")

      // A second click is answered with the same decision, never new work
      const again = await respondToExecutionEnvironment({
        taskId: first.id,
        requesterId: TEST_USER,
        choice: "cloud",
        availability: BOTH,
      })
      expect(again.kind).toBe("selected")
      if (again.kind !== "selected") return
      expect(again.duplicate).toBe(true)

      await db.delete(executionTasks).where(eq(executionTasks.id, first.id))
    })

    it("cancels a pending task and leaves no work behind", async () => {
      const { db } = await import("@/db")
      const { executionTasks } = await import("@/db/schema")
      const { eq } = await import("drizzle-orm")
      const {
        activeExecutionTask,
        ensureAwaitingExecutionTask,
        respondToExecutionEnvironment,
      } = await import("@/lib/execution-tasks")

      const task = await ensureAwaitingExecutionTask({
        userId: TEST_USER,
        conversationId: "chat-test-2",
        request: "Extrae los títulos de este blog",
        availability: BOTH,
      })

      const cancelled = await respondToExecutionEnvironment({
        taskId: task.id,
        requesterId: TEST_USER,
        choice: "cancel",
        availability: BOTH,
      })

      expect(cancelled.kind).toBe("cancelled")
      expect(await activeExecutionTask("chat-test-2", TEST_USER)).toBeNull()

      const stored = await db
        .select()
        .from(executionTasks)
        .where(eq(executionTasks.id, task.id))
      expect(stored[0]?.status).toBe("cancelled")
      expect(stored[0]?.environment ?? null).toBeNull()

      await db.delete(executionTasks).where(eq(executionTasks.id, task.id))
    })

    it("refuses an environment that is not available, keeping the task pending", async () => {
      const { db } = await import("@/db")
      const { executionTasks } = await import("@/db/schema")
      const { eq } = await import("drizzle-orm")
      const {
        ensureAwaitingExecutionTask,
        respondToExecutionEnvironment,
      } = await import("@/lib/execution-tasks")

      const task = await ensureAwaitingExecutionTask({
        userId: TEST_USER,
        conversationId: "chat-test-3",
        request: "Compara los precios de tres tiendas",
        availability: BOTH,
      })

      const refused = await respondToExecutionEnvironment({
        taskId: task.id,
        requesterId: TEST_USER,
        choice: "local",
        availability: {
          cloud: { available: true },
          local: { available: false, reason: "no computer is online" },
        },
      })

      expect(refused.kind).toBe("rejected")
      if (refused.kind === "rejected") {
        expect(refused.code).toBe("unavailable")
        expect(refused.message).toContain("no computer is online")
      }

      const stored = await db
        .select()
        .from(executionTasks)
        .where(eq(executionTasks.id, task.id))
      expect(stored[0]?.status).toBe("awaiting_execution_environment")

      await db.delete(executionTasks).where(eq(executionTasks.id, task.id))
    })
  }
)
