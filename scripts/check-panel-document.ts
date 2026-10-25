// Throwaway check for lib/panels/document.ts: validation, clamping, legacy
// conversion and the merge that protects saved data across structure edits.
import assert from "node:assert/strict"

import {
  applyBlockData,
  configFromDocument,
  createDocument,
  mergePanelDocuments,
  readPanelDocument,
} from "../lib/panels/document"

function it(name: string, fn: () => void) {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`FAIL - ${name}`)
    throw error
  }
}

it("drops unknown block types", () => {
  const doc = createDocument({
    blocks: [
      { type: "heading", text: "Hola" },
      { type: "script", text: "<script>alert(1)</script>" },
      { type: "text", text: "Cuerpo" },
    ],
  })
  assert.equal(doc.blocks.length, 2)
  assert.deepEqual(doc.blocks.map((b) => b.type), ["heading", "text"])
})

it("clamps oversized text and item lists", () => {
  const doc = createDocument({
    blocks: [
      {
        type: "checklist",
        items: Array.from({ length: 500 }, (_, index) => ({
          label: `item ${index}`,
        })),
      },
      { type: "text", text: "x".repeat(9000) },
    ],
  })
  const checklist = doc.blocks[0]
  assert.equal(checklist.type, "checklist")
  if (checklist.type !== "checklist") return
  assert.equal(checklist.items.length, 200)

  const text = doc.blocks[1]
  assert.equal(text.type, "text")
  if (text.type !== "text") return
  assert.equal(text.text.length, 2000)
})

it("normalizes rows that arrive as arrays or objects", () => {
  const doc = createDocument({
    blocks: [
      {
        type: "table",
        columns: ["A", "B"],
        rows: [["1", "2"], { A: "3", B: "4" }, { cells: ["5", "6"] }],
      },
    ],
  })
  const table = doc.blocks[0]
  assert.equal(table.type, "table")
  if (table.type !== "table") return
  assert.deepEqual(
    table.rows.map((row) => row.cells),
    [["1", "2"], ["3", "4"], ["5", "6"]]
  )
})

it("keeps ids unique", () => {
  const doc = createDocument({
    blocks: [
      { id: "same", type: "text", text: "a" },
      { id: "same", type: "text", text: "b" },
    ],
  })
  assert.notEqual(doc.blocks[0].id, doc.blocks[1].id)
})

it("converts a legacy posts config into a table", () => {
  const doc = readPanelDocument({
    title: "Social Planner",
    posts: [
      { content: "Lanzamiento", platform: "instagram", status: "borrador" },
    ],
  })
  const table = doc.blocks.find((block) => block.type === "table")
  assert.ok(table)
  if (!table || table.type !== "table") return
  assert.equal(table.rows.length, 1)
  assert.equal(table.rows[0].cells[0], "Lanzamiento")
})

it("keeps saved data when an agent rewrites the structure", () => {
  const previous = createDocument({
    description: "Rutina",
    blocks: [
      { id: "dias", type: "checklist", items: [{ id: "lun", label: "Lunes" }] },
      { id: "notas", type: "text", text: "viejas" },
    ],
  })
  const ticked = applyBlockData(previous.blocks[0], {
    items: [{ id: "lun", label: "Lunes", done: true }],
  })
  assert.ok(ticked)
  previous.blocks[0] = ticked!

  const next = createDocument({
    description: "Rutina v2",
    blocks: [
      { id: "nuevo", type: "heading", text: "Semana" },
      { id: "dias", type: "checklist", items: [{ id: "lun", label: "Lunes" }] },
    ],
  })

  const merged = mergePanelDocuments(previous, next)
  const days = merged.blocks.find((block) => block.id === "dias")
  assert.ok(days && days.type === "checklist")
  if (!days || days.type !== "checklist") return
  assert.equal(days.items[0].done, true)
  assert.equal(merged.description, "Rutina v2")
  assert.equal(merged.blocks.length, 2)
})

it("rejects data that does not fit the block", () => {
  const doc = createDocument({ blocks: [{ id: "t", type: "text", text: "x" }] })
  assert.equal(applyBlockData(doc.blocks[0], { items: [] }), null)
})

it("round-trips through the widget config", () => {
  const doc = createDocument({
    description: "Panel",
    blocks: [{ id: "t", type: "text", text: "hola" }],
  })
  const config = configFromDocument({ version: 2, extra: true }, doc)
  assert.equal(config.extra, true)
  const again = readPanelDocument(config)
  assert.equal(again.blocks.length, 1)
  assert.equal(again.description, "Panel")
})
