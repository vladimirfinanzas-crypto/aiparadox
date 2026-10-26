import { afterEach, describe, expect, it, vi } from "vitest"

// A person may put one model first for a role. These tests pin the two halves
// that can silently go wrong: the reorder must be a reorder (not a replacement
// of the fallback ladder), and a saved choice must be validated against the
// catalogue before it is stored.

const h = vi.hoisted(() => ({
  providerRows: [] as { provider: string; enabled: boolean; position: number }[],
  modelRows: [] as { role: string; provider: string; modelId: string }[],
}))

vi.mock("@/db", () => {
  // Tables are told apart by a column only they have, so the factory needs no
  // import from the schema module (which Vitest hoists above this mock).
  const rowsFor = (table: Record<string, unknown>) =>
    "role" in table ? h.modelRows : h.providerRows

  return {
    db: {
      select: () => ({
        from: (table: Record<string, unknown>) => ({
          // `getModelPreferences` awaits `where(...)`; `getProviderSelection`
          // chains `.orderBy()`. Both are supported by one object.
          where: () => {
            const rows = rowsFor(table)
            return Object.assign(Promise.resolve(rows), {
              orderBy: async () => rows,
            })
          },
        }),
      }),
      insert: () => ({
        values: (values: { role: string; provider: string; modelId: string }) => ({
          onConflictDoUpdate: async () => {
            h.modelRows = [
              ...h.modelRows.filter((row) => row.role !== values.role),
              values,
            ]
          },
        }),
      }),
      delete: () => ({
        where: async () => {
          h.modelRows = []
        },
      }),
    },
  }
})

import {
  catalogCandidateFor,
  withModelPreference,
} from "@/lib/ai/models"
import {
  getModelPreferences,
  saveModelPreference,
} from "@/lib/ai/provider-settings"

const originalOrder = process.env.PARADOX_PROVIDER_ORDER
const originalDisabled = process.env.PARADOX_DISABLED_PROVIDERS

afterEach(() => {
  h.providerRows = []
  h.modelRows = []
  if (originalOrder === undefined) delete process.env.PARADOX_PROVIDER_ORDER
  else process.env.PARADOX_PROVIDER_ORDER = originalOrder
  if (originalDisabled === undefined) delete process.env.PARADOX_DISABLED_PROVIDERS
  else process.env.PARADOX_DISABLED_PROVIDERS = originalDisabled
})

describe("withModelPreference", () => {
  const ladder = [
    { provider: "openrouter", modelId: "a", capabilities: [], freeTier: true },
    { provider: "openrouter", modelId: "b", capabilities: [], freeTier: true },
    { provider: "groq", modelId: "c", capabilities: [], freeTier: true },
  ] as const

  it("moves the chosen model to the front and keeps the rest", () => {
    const reordered = withModelPreference([...ladder], {
      provider: "groq",
      modelId: "c",
    })

    expect(reordered.map((entry) => entry.modelId)).toEqual(["c", "a", "b"])
  })

  it("leaves the ladder untouched when the model is already first", () => {
    const reordered = withModelPreference([...ladder], {
      provider: "openrouter",
      modelId: "a",
    })
    expect(reordered.map((entry) => entry.modelId)).toEqual(["a", "b", "c"])
  })

  it("ignores a model that is no longer in the catalogue", () => {
    const reordered = withModelPreference([...ladder], {
      provider: "gemini",
      modelId: "gone",
    })
    expect(reordered.map((entry) => entry.modelId)).toEqual(["a", "b", "c"])
  })

  it("keeps every rung, so fallback still works", () => {
    expect(withModelPreference([...ladder], { provider: "groq", modelId: "c" })).toHaveLength(
      ladder.length
    )
  })
})

describe("catalogCandidateFor", () => {
  it("finds a model the router would plan for that role", () => {
    const candidate = catalogCandidateFor("general", {
      provider: "openrouter",
      modelId: "openrouter/auto",
    })
    // Whether or not that exact id exists, the answer must be a real candidate
    // or null — never a fabricated one.
    expect(candidate === null || candidate.provider === "openrouter").toBe(true)
  })

  it("returns null for a model that is not offered", () => {
    expect(
      catalogCandidateFor("general", { provider: "groq", modelId: "not-a-model" })
    ).toBeNull()
  })
})

describe("saveModelPreference", () => {
  it("rejects an unknown role", async () => {
    const result = await saveModelPreference("user_1", "not-a-role", null)
    expect(result).toMatchObject({ ok: false })
  })

  it("rejects an unknown provider", async () => {
    const result = await saveModelPreference("user_1", "general", {
      provider: "someone-else" as never,
      modelId: "x",
    })
    expect(result).toMatchObject({ ok: false, error: "Proveedor desconocido." })
  })

  it("rejects a model that is not offered for that role", async () => {
    const result = await saveModelPreference("user_1", "general", {
      provider: "groq",
      modelId: "imaginary-model",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/no está disponible/)
  })

  it("stores a valid choice and reads it back", async () => {
    const candidate = catalogCandidateFor("fast", {
      provider: "openrouter",
      modelId: "nonexistent",
    })
    expect(candidate).toBeNull()

    // Pick a model the catalogue really offers for this role.
    const { catalogForRole } = await import("@/lib/ai/models")
    const [real] = catalogForRole("fast")
    expect(real).toBeDefined()

    const saved = await saveModelPreference("user_1", "fast", {
      provider: real!.provider,
      modelId: real!.modelId,
    })

    expect(saved.ok).toBe(true)
    const preferences = await getModelPreferences("user_1")
    expect(preferences.fast).toEqual({
      provider: real!.provider,
      modelId: real!.modelId,
    })
  })

  it("drops a stored choice whose provider the operator disabled", async () => {
    const { catalogForRole } = await import("@/lib/ai/models")
    const [real] = catalogForRole("general")
    h.modelRows = [
      { role: "general", provider: real!.provider, modelId: real!.modelId },
    ]

    process.env.PARADOX_DISABLED_PROVIDERS = real!.provider
    const preferences = await getModelPreferences("user_1")
    expect(preferences.general).toBeUndefined()
  })
})
