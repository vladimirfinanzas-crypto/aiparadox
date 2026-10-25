import { describe, expect, it } from "vitest"

// Integration check for the execution manager against the real database. It
// only runs where a database is configured (`.env`), so `npm test` stays green
// in a clean checkout: without DATABASE_URL the suite is skipped, not faked.
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

const TEST_USER = "__tool_registry_test__"

// The first statement pays for the TLS handshake and pool warm-up on a remote
// database, which regularly exceeds Vitest's 5s default when the suite runs in
// parallel. The assertions are unchanged; only the budget for the connection is.
describe.skipIf(!hasDatabase)(
  "tool executions against the real database",
  { timeout: 20_000 },
  () => {
  it("records a call as completed and can be read back", async () => {
    const { wrapToolsForExecution } = await import("@/lib/tool-executions")
    const { db } = await import("@/db")
    const { executions } = await import("@/db/schema")
    const { eq } = await import("drizzle-orm")

    // Leftovers from an interrupted run never survive into this one
    await db.delete(executions).where(eq(executions.userId, TEST_USER))

    const tools = wrapToolsForExecution(
      {
        panel_create: {
          execute: async (input: { name: string }) => ({ id: "w_test", ...input }),
        },
      },
      { userId: TEST_USER, conversationId: "chat_test" }
    )

    const result = await tools.panel_create.execute({ name: "Prueba" })
    expect(result).toEqual({ id: "w_test", name: "Prueba" })

    const rows = await db
      .select()
      .from(executions)
      .where(eq(executions.userId, TEST_USER))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.role).toBe("tool")
    expect(rows[0]?.status).toBe("completed")
    expect(rows[0]?.prompt).toContain("panel_create")
    expect(rows[0]?.result).toContain("w_test")
    expect(rows[0]?.conversationId).toBe("chat_test")
    expect(rows[0]?.completedAt).not.toBeNull()

    // The row is a test artifact, not product data
    await db.delete(executions).where(eq(executions.userId, TEST_USER))
  })

  it("records a failure and leaves no half-finished row", async () => {
    const { wrapToolsForExecution } = await import("@/lib/tool-executions")
    const { db } = await import("@/db")
    const { executions } = await import("@/db/schema")
    const { eq } = await import("drizzle-orm")

    await db.delete(executions).where(eq(executions.userId, TEST_USER))

    const tools = wrapToolsForExecution(
      {
        email_send: {
          execute: async () => {
            throw new Error("RESEND_API_KEY is not set")
          },
        },
      },
      { userId: TEST_USER, conversationId: "chat_test" }
    )

    await expect(tools.email_send.execute()).rejects.toThrow("RESEND_API_KEY")

    const rows = await db
      .select()
      .from(executions)
      .where(eq(executions.userId, TEST_USER))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe("failed")
    expect(rows[0]?.error).toContain("RESEND_API_KEY")

    await db.delete(executions).where(eq(executions.userId, TEST_USER))
  })
})
