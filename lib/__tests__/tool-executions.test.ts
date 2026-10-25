import { describe, expect, it, vi } from "vitest"

// The execution manager writes to the database; every write is mocked so the
// test only observes what the wrapper records and re-throws.
const h = vi.hoisted(() => ({
  inserted: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  failInsert: false,
  reset() {
    this.inserted.length = 0
    this.updates.length = 0
    this.failInsert = false
  },
}))

vi.mock("@/db", () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          if (h.failInsert) throw new Error("database down")
          h.inserted.push(values)
          return [{ id: "exec-1" }]
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          h.updates.push(patch)
        },
      }),
    }),
  },
}))

import { wrapToolsForExecution } from "@/lib/tool-executions"

const CTX = { userId: "user_1", conversationId: "chat_1" }

describe("wrapToolsForExecution", () => {
  it("records a call as running and then completed", async () => {
    h.reset()
    const tools = wrapToolsForExecution(
      {
        panel_create: {
          inputSchema: { kind: "object" },
          execute: async (args: { name: string }) => ({ id: "w_1", ...args }),
        },
      },
      CTX
    )

    const result = await tools.panel_create.execute({ name: "Gastos" })

    expect(result).toEqual({ id: "w_1", name: "Gastos" })
    expect(h.inserted).toHaveLength(1)
    expect(h.inserted[0]).toMatchObject({
      userId: "user_1",
      conversationId: "chat_1",
      role: "tool",
      status: "running",
    })
    expect(String(h.inserted[0].prompt)).toContain("panel_create")
    expect(String(h.inserted[0].prompt)).toContain("Gastos")

    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].status).toBe("completed")
    expect(String(h.updates[0].result)).toContain("w_1")
    expect(h.updates[0].completedAt).toBeInstanceOf(Date)
  })

  it("records a failure and rethrows the original error", async () => {
    h.reset()
    const tools = wrapToolsForExecution(
      {
        browser_navigate: {
          execute: async () => {
            throw new Error("BROWSERBASE_API_KEY is not set")
          },
        },
      },
      CTX
    )

    await expect(tools.browser_navigate.execute()).rejects.toThrow(
      "BROWSERBASE_API_KEY is not set"
    )

    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].status).toBe("failed")
    expect(h.updates[0].error).toContain("BROWSERBASE_API_KEY")
    expect(h.updates[0].result).toBeUndefined()
  })

  it("leaves tools without an execute function untouched", () => {
    h.reset()
    const definition = { description: "only a schema", inputSchema: {} }
    const tools = wrapToolsForExecution({ schema_only: definition }, CTX)

    expect(tools.schema_only).toBe(definition)
    expect(h.inserted).toHaveLength(0)
  })

  it("never lets a logging failure break the tool it logs", async () => {
    h.reset()
    h.failInsert = true
    const tools = wrapToolsForExecution(
      { panel_get: { execute: async () => ({ ok: true }) } },
      CTX
    )

    await expect(tools.panel_get.execute()).resolves.toEqual({ ok: true })
    expect(h.updates).toHaveLength(0)
  })

  it("truncates a large result instead of storing the payload", async () => {
    h.reset()
    const tools = wrapToolsForExecution(
      { browser_screenshot: { execute: async () => "x".repeat(5000) } },
      CTX
    )

    await tools.browser_screenshot.execute()
    expect(String(h.updates[0].result).length).toBeLessThan(2100)
    expect(String(h.updates[0].result).endsWith("…")).toBe(true)
  })
})
