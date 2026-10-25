import { describe, expect, it } from "vitest"

// Integration checks against the real database. Skipped (not faked) when there
// is no DATABASE_URL, so a clean checkout still passes `npm test`.
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

const USER_A = "__automations_test_a__"
const USER_B = "__automations_test_b__"

describe.skipIf(!hasDatabase)(
  "automations against the real database",
  { timeout: 25_000 },
  () => {
    it("saves versions, keeps owners apart and dedupes runs", async () => {
      const { db } = await import("@/db")
      const { workflows, automationRuns } = await import("@/db/schema")
      const { eq, inArray } = await import("drizzle-orm")
      const {
        createAutomation,
        createRun,
        getAutomation,
        listVersions,
        saveAutomationDefinition,
      } = await import("@/queries/automations")
      const { emptyDefinition } = await import("@/lib/automations/definition")

      // Clean slate for these two fake owners
      await db.delete(workflows).where(inArray(workflows.userId, [USER_A, USER_B]))

      const base = emptyDefinition("Prueba de integración", "Europe/Madrid")
      const automation = await createAutomation({
        userId: USER_A,
        name: base.name,
        definition: base,
      })

      expect(automation.version).toBe(1)
      expect(automation.status).toBe("draft")

      // Someone else's id resolves to nothing
      expect(await getAutomation(USER_B, automation.id)).toBeNull()

      // A real change creates a version
      const changed = {
        ...base,
        nodes: [
          ...base.nodes,
          {
            id: "pause",
            type: "delay" as const,
            kind: "action" as const,
            title: "Esperar",
            config: { seconds: "1" },
            position: { x: 260, y: 0 },
          },
        ],
        edges: [{ id: "e1", source: "start", target: "pause" }],
      }

      const saved = await saveAutomationDefinition({
        userId: USER_A,
        id: automation.id,
        definition: changed,
      })
      expect(saved.version).toBe(2)
      expect(saved.unchanged).toBe(false)

      // Saving the same document again does not invent a version
      const again = await saveAutomationDefinition({
        userId: USER_A,
        id: automation.id,
        definition: changed,
      })
      expect(again.version).toBe(2)
      expect(again.unchanged).toBe(true)

      const versions = await listVersions({ userId: USER_A, workflowId: automation.id })
      expect(versions.map((row) => row.version)).toEqual([2, 1])

      // The same idempotency key returns the original run instead of a second
      const key = `test:${automation.id}`
      const first = await createRun({
        userId: USER_A,
        workflowId: automation.id,
        version: 2,
        origin: "manual",
        environment: "cloud",
        idempotencyKey: key,
      })
      const second = await createRun({
        userId: USER_A,
        workflowId: automation.id,
        version: 2,
        origin: "manual",
        environment: "cloud",
        idempotencyKey: key,
      })

      expect(second.id).toBe(first.id)
      expect(await db.select().from(automationRuns).where(eq(automationRuns.workflowId, automation.id))).toHaveLength(1)

      await db.delete(workflows).where(inArray(workflows.userId, [USER_A, USER_B]))
    })

    it("invalidates an approval when the consequences change", async () => {
      const { db } = await import("@/db")
      const { workflows } = await import("@/db/schema")
      const { eq } = await import("drizzle-orm")
      const { createApproval, createAutomation, listApprovals } = await import(
        "@/queries/automations"
      )
      const { automationScopeHash, canRunUnattended } = await import(
        "@/lib/automations/approvals"
      )
      const { emptyDefinition } = await import("@/lib/automations/definition")

      const start = {
        id: "start",
        type: "start" as const,
        kind: "trigger" as const,
        title: "Start",
        config: {},
        position: { x: 0, y: 0 },
      }
      const mail = {
        id: "mail",
        type: "send-email" as const,
        kind: "action" as const,
        title: "Avisar",
        config: { to: "a@b.c", subject: "Hola", body: "Resumen" },
        position: { x: 260, y: 0 },
      }

      const required = {
        ...emptyDefinition("Aprobación", "Europe/Madrid"),
        trigger: { kind: "cron" as const, cron: "0 9 * * 1", timezone: "Europe/Madrid" },
        nodes: [start, mail],
        edges: [{ id: "e1", source: "start", target: "mail" }],
      }

      const automation = await createAutomation({
        userId: USER_A,
        name: required.name,
        definition: required,
      })

      await createApproval({
        userId: USER_A,
        workflowId: automation.id,
        version: 1,
        scopeHash: automationScopeHash(required),
        actions: [{ nodeId: "mail", type: "send-email", label: "Avisar" }],
      })

      const approvals = await listApprovals({ userId: USER_A, workflowId: automation.id })

      expect(
        canRunUnattended({ definition: required, version: 1, approvals, status: "active" })
      ).toEqual({ ok: true })

      // Same flow, different recipient: the approval no longer covers it
      const changed = {
        ...required,
        nodes: [start, { ...mail, config: { ...mail.config, to: "otro@b.c" } }],
      }

      const blocked = canRunUnattended({
        definition: changed,
        version: 1,
        approvals,
        status: "active",
      })
      expect(blocked.ok).toBe(false)

      // And a draft cannot run by itself, approval or not
      expect(
        canRunUnattended({ definition: required, version: 1, approvals, status: "draft" }).ok
      ).toBe(false)

      await db.delete(workflows).where(eq(workflows.userId, USER_A))
    })
  }
)
