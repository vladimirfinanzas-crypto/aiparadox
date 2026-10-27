import { describe, expect, it } from "vitest"

import {
  nodeCategories,
  nodeRegistry,
} from "@/features/workflows/nodes/node-registry"
import { nodeCatalog, nodeTypes } from "@/lib/automations/catalog"

// The palette is a projection of the catalogue. These pin the pairing so a new
// block cannot ship without a shelf (it would silently vanish from the UI), and
// so a shelf cannot advertise a capability that has no block behind it.

describe("palette categories", () => {
  it("gives every block exactly one of the published categories", () => {
    const published = new Set(nodeCategories.map((category) => category.id))

    for (const type of nodeTypes) {
      const def = nodeRegistry[type]
      expect(def, `missing registry entry for ${type}`).toBeDefined()
      expect(
        published.has(def.category),
        `${type} sits on "${def.category}", which is not a published category`
      ).toBe(true)
    }
  })

  it("covers every category the product promises", () => {
    expect(nodeCategories.map((category) => category.id)).toEqual([
      "triggers",
      "ai",
      "browser",
      "desktop",
      "integrations",
      "logic",
    ])
  })

  it("leaves no shelf empty", () => {
    for (const category of nodeCategories) {
      const items = Object.values(nodeRegistry).filter(
        (def) => def.category === category.id
      )
      expect(items.length, `shelf "${category.id}" has no blocks`).toBeGreaterThan(0)
    }
  })

  it("keeps triggers on the trigger shelf", () => {
    for (const type of nodeTypes) {
      if (nodeCatalog[type].kind === "trigger") {
        expect(nodeRegistry[type]!.category).toBe("triggers")
      }
    }
  })
})
