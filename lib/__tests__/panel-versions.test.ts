import { describe, expect, it } from "vitest"

import {
  createDocument,
  normalizeBlocks,
  structureChanged,
  type PanelDocument,
} from "@/lib/panels/document"

// A version is a layout change. What the person types inside a block is data,
// and must never create one — otherwise the history fills with one entry per
// keystroke and a restore becomes impossible to reason about.

const base: PanelDocument = createDocument({
  description: "Tablero",
  blocks: [
    { id: "titulo", type: "heading", text: "Hoy", level: 2 },
    { id: "tareas", type: "checklist", title: "Tareas", items: [{ id: "a", label: "Una", done: false }] },
    { id: "gastos", type: "table", title: "Gastos", columns: ["Concepto", "Importe"], rows: [] },
    { id: "resumen", type: "stats", title: "Resumen", items: [{ label: "Hechas", value: "0" }] },
  ],
})

describe("panel versions", () => {
  it("ignores the data the runtime writes", () => {
    const ticked = normalizeBlocks([
      { id: "titulo", type: "heading", text: "Hoy", level: 2 },
      { id: "tareas", type: "checklist", title: "Tareas", items: [{ id: "a", label: "Una", done: true }] },
      {
        id: "gastos",
        type: "table",
        title: "Gastos",
        columns: ["Concepto", "Importe"],
        rows: [{ id: "fila-1", cells: ["Café", "2,50"] }],
      },
      { id: "resumen", type: "stats", title: "Resumen", items: [{ label: "Hechas", value: "0" }] },
    ])

    expect(structureChanged(base, { ...base, blocks: ticked })).toBe(false)
  })

  it("counts a structural change", () => {
    const withNote = createDocument({
      description: "Tablero",
      blocks: [...base.blocks, { id: "nota", type: "text", text: "Solo para hoy" }],
    })

    expect(structureChanged(base, withNote)).toBe(true)
  })

  it("counts a change to content the runtime cannot edit", () => {
    const retitled = normalizeBlocks([
      { id: "titulo", type: "heading", text: "Mañana", level: 2 },
      { id: "tareas", type: "checklist", title: "Tareas", items: [{ id: "a", label: "Una", done: false }] },
      { id: "gastos", type: "table", title: "Gastos", columns: ["Concepto", "Importe"], rows: [] },
      { id: "resumen", type: "stats", title: "Resumen", items: [{ label: "Hechas", value: "7" }] },
    ])

    expect(structureChanged(base, { ...base, blocks: retitled })).toBe(true)
  })

  it("counts a change of purpose", () => {
    expect(structureChanged(base, { ...base, description: "Otra cosa" })).toBe(true)
  })
})
