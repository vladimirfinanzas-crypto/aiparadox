import { describe, expect, it } from "vitest"

// Workspace against the real database: versioning, data preservation across a
// structural change, restore, and isolation between accounts. Like the other
// database suites, it is skipped — never faked — when no database is configured.
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

const USER_A = "__workspace_test_a__"
const USER_B = "__workspace_test_b__"

const emptyDocument = {
  version: 2 as const,
  description: "Tablero de prueba",
  blocks: [
    { id: "tareas", type: "checklist" as const, title: "Tareas", items: [
      { id: "tarea-1", label: "Primera", done: false },
      { id: "tarea-2", label: "Segunda", done: false },
    ] },
  ],
}

describe.skipIf(!hasDatabase)(
  "workspace panels against the real database",
  { timeout: 30_000 },
  () => {
    const cleanup = async () => {
      const { db } = await import("@/db")
      const { widgets } = await import("@/db/schema")
      const { inArray } = await import("drizzle-orm")
      // Versions cascade with the panel
      await db.delete(widgets).where(inArray(widgets.userId, [USER_A, USER_B]))
    }

    it("creates a panel with its first version and keeps the data across a structural change", async () => {
      const {
        createWorkspacePanel,
        listWorkspacePanels,
        listWorkspaceVersions,
        requireWorkspacePanel,
        saveWorkspacePanel,
      } = await import("@/queries/workspace")
      const { mergePanelDocuments, readPanelDocument } = await import(
        "@/lib/panels/document"
      )
      const { db } = await import("@/db")
      const { widgets } = await import("@/db/schema")
      const { and, eq } = await import("drizzle-orm")

      await cleanup()

      const panel = await createWorkspacePanel({
        userId: USER_A,
        name: "Tablero",
        document: emptyDocument,
      })

      expect(panel.version).toBe(1)

      const versions = await listWorkspaceVersions(USER_A, panel.id)
      expect(versions).toHaveLength(1)
      expect(versions[0]?.version).toBe(1)
      expect(versions[0]?.blocks).toBe(1)

      // The person ticks the first task: runtime data, saved per block.
      const ticked = {
        ...emptyDocument,
        blocks: [
          {
            id: "tareas",
            type: "checklist" as const,
            title: "Tareas",
            items: [
              { id: "tarea-1", label: "Primera", done: true },
              { id: "tarea-2", label: "Segunda", done: false },
            ],
          },
        ],
      }

      await db
        .update(widgets)
        .set({ config: ticked })
        .where(and(eq(widgets.id, panel.id), eq(widgets.userId, USER_A)))

      const current = await requireWorkspacePanel(USER_A, panel.id)
      const currentDocument = readPanelDocument(current.config)

      // What Godfather's proposal path does: a new layout, where blocks that
      // survived keep the data the person already entered.
      const proposal = mergePanelDocuments(currentDocument, {
        version: 2,
        description: "Tablero de prueba",
        blocks: [
          { id: "tareas", type: "checklist", title: "Tareas", items: [] },
          { id: "notas", type: "text", text: "Solo para hoy" },
        ],
      })

      const keptChecklist = proposal.blocks.find((block) => block.id === "tareas")
      expect(keptChecklist?.type).toBe("checklist")
      expect(
        keptChecklist?.type === "checklist" ? keptChecklist.items[0]?.done : null
      ).toBe(true)

      const saved = await saveWorkspacePanel({
        userId: USER_A,
        id: panel.id,
        document: proposal,
        author: "godfather",
        summary: "Cambio propuesto por Godfather",
      })

      expect(saved.changed).toBe(true)
      expect(saved.version).toBe(2)

      const history = await listWorkspaceVersions(USER_A, panel.id)
      expect(history.map((item) => item.version)).toEqual([2, 1])
      expect(history[0]?.author).toBe("godfather")

      // Saving the same layout again is not a new version.
      const again = await saveWorkspacePanel({
        userId: USER_A,
        id: panel.id,
        document: proposal,
      })
      expect(again.changed).toBe(false)
      expect(again.version).toBe(2)

      // The panel keeps the ticked task after the layout change.
      const after = await requireWorkspacePanel(USER_A, panel.id)
      const checklist = (after.config.blocks as { id: string; items: { done: boolean }[] }[]).find(
        (block) => block.id === "tareas"
      )
      expect(checklist?.items[0]?.done).toBe(true)

      const library = await listWorkspacePanels(USER_A)
      expect(library).toHaveLength(1)
      expect(library[0]?.version).toBe(2)
      expect(library[0]?.name).toBe("Tablero")

      await cleanup()
    })

    it("restores an earlier layout as a new version", async () => {
      const {
        createWorkspacePanel,
        getWorkspacePanel,
        listWorkspaceVersions,
        restoreWorkspaceVersion,
        saveWorkspacePanel,
        requireWorkspacePanel,
      } = await import("@/queries/workspace")

      await cleanup()

      const panel = await createWorkspacePanel({
        userId: USER_A,
        name: "Restaurable",
        document: emptyDocument,
      })

      await saveWorkspacePanel({
        userId: USER_A,
        id: panel.id,
        document: {
          version: 2,
          description: "Otra cosa",
          blocks: [{ id: "texto", type: "text", text: "Reemplazo total" }],
        },
        author: "godfather",
      })

      const restored = await restoreWorkspaceVersion({
        userId: USER_A,
        id: panel.id,
        version: 1,
      })

      expect(restored.version).toBe(3)

      const current = await requireWorkspacePanel(USER_A, panel.id)
      const document = current.config as unknown as { blocks: { id: string }[] }
      expect(document.blocks.map((block) => block.id)).toEqual(["tareas"])

      const history = await listWorkspaceVersions(USER_A, panel.id)
      expect(history.map((item) => item.version)).toEqual([3, 2, 1])
      expect(history[0]?.note).toContain("versión 1")

      // A version number that does not exist never resolves.
      await expect(
        restoreWorkspaceVersion({ userId: USER_A, id: panel.id, version: 99 })
      ).rejects.toThrow()

      expect(await getWorkspacePanel(USER_A, panel.id)).not.toBeNull()

      await cleanup()
    })

    it("never exposes another account's panel or its history", async () => {
      const {
        createWorkspacePanel,
        deleteWorkspacePanel,
        getWorkspacePanel,
        listWorkspacePanels,
        listWorkspaceVersions,
        restoreWorkspaceVersion,
        saveWorkspacePanel,
      } = await import("@/queries/workspace")

      await cleanup()

      const panel = await createWorkspacePanel({
        userId: USER_A,
        name: "Privado",
        document: emptyDocument,
      })

      // The same id, asked for by another account, does not resolve.
      expect(await getWorkspacePanel(USER_B, panel.id)).toBeNull()
      expect(await listWorkspaceVersions(USER_B, panel.id)).toEqual([])
      expect(await listWorkspacePanels(USER_B)).toEqual([])

      await expect(
        saveWorkspacePanel({
          userId: USER_B,
          id: panel.id,
          document: { version: 2, blocks: [{ id: "x", type: "text", text: "intruso" }] },
        })
      ).rejects.toThrow()

      await expect(
        restoreWorkspaceVersion({ userId: USER_B, id: panel.id, version: 1 })
      ).rejects.toThrow()

      await expect(deleteWorkspacePanel(USER_B, panel.id)).rejects.toThrow()

      // Nothing was written and the owner still sees it.
      expect(await getWorkspacePanel(USER_A, panel.id)).not.toBeNull()

      await cleanup()
    })
  }
)
