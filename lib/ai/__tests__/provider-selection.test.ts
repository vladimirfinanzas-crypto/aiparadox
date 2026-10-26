import { afterEach, describe, expect, it, vi } from "vitest"

// The integration centre's selection is applied by the router, not duplicated by
// it. These tests pin the two rules that matter: the person can only skip and
// reorder providers, and the operator's opt-out always wins.

const h = vi.hoisted(() => ({
  rows: [] as { provider: string; enabled: boolean; position: number }[],
}))

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => h.rows,
        }),
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        delete: () => ({
          where: async () => {
            h.rows = []
          },
        }),
        insert: () => ({
          values: async (
            rows: { provider: string; enabled: boolean; position: number }[]
          ) => {
            h.rows = rows
          },
        }),
      }),
  },
}))

import { catalogForRole, catalogModelIds } from "@/lib/ai/models"
import {
  defaultSelection,
  getProviderSelection,
  saveProviderSelection,
} from "@/lib/ai/provider-settings"

const originalOrder = process.env.PARADOX_PROVIDER_ORDER
const originalDisabled = process.env.PARADOX_DISABLED_PROVIDERS

afterEach(() => {
  h.rows = []
  if (originalOrder === undefined) delete process.env.PARADOX_PROVIDER_ORDER
  else process.env.PARADOX_PROVIDER_ORDER = originalOrder
  if (originalDisabled === undefined) delete process.env.PARADOX_DISABLED_PROVIDERS
  else process.env.PARADOX_DISABLED_PROVIDERS = originalDisabled
})

describe("catalogForRole with a person's selection", () => {
  it("follows the saved order", () => {
    const first = catalogForRole("general", { order: ["groq", "openrouter"] })[0]
    expect(first?.provider).toBe("groq")
  })

  it("drops a provider the person switched off, wherever it sits in the order", () => {
    const providers = catalogForRole("general", {
      order: ["groq", "openrouter"],
      disabled: ["groq"],
    }).map((candidate) => candidate.provider)

    expect(providers).not.toContain("groq")
    expect(providers).toContain("openrouter")
  })

  it("cannot re-enable a provider the operator disabled", () => {
    process.env.PARADOX_DISABLED_PROVIDERS = "groq"

    const providers = catalogForRole("general", {
      order: ["groq", "openrouter"],
      disabled: [],
    }).map((candidate) => candidate.provider)

    expect(providers).not.toContain("groq")
    expect(providers.length).toBeGreaterThan(0)
  })

  it("ignores an unknown provider id left over from an older save", () => {
    const candidates = catalogForRole("general", {
      // Cast: rows written by an older catalogue can contain other values.
      order: ["legacy-provider", "openrouter"] as never,
    })

    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.map((candidate) => candidate.provider)).toContain("openrouter")
  })

  it("falls back to the environment order when nothing was saved", () => {
    process.env.PARADOX_PROVIDER_ORDER = "gemini,openrouter"
    const first = catalogForRole("general")[0]
    expect(first?.provider).toBe("gemini")
  })

  it("applies the selection to the model-id list too", () => {
    const all = catalogModelIds()
    const onlyGroq = catalogModelIds({ order: ["groq"] })
    expect(onlyGroq.length).toBeLessThan(all.length)
    expect(onlyGroq.every((entry) => entry.provider === "groq")).toBe(true)
  })
})

describe("getProviderSelection", () => {
  it("returns the environment defaults for an account that never saved", async () => {
    const selection = await getProviderSelection("user_1")
    expect(selection).toEqual(defaultSelection())
  })

  it("merges a partial save with the providers added since", async () => {
    h.rows = [
      { provider: "groq", enabled: true, position: 0 },
      { provider: "openrouter", enabled: true, position: 1 },
    ]

    const selection = await getProviderSelection("user_1")

    expect(selection.order.slice(0, 2)).toEqual(["groq", "openrouter"])
    // Everything else keeps a place instead of disappearing
    expect(new Set(selection.order).size).toBe(5)
  })

  it("keeps the operator's opt-out even when the stored row says enabled", async () => {
    process.env.PARADOX_DISABLED_PROVIDERS = "cerebras"
    h.rows = [{ provider: "cerebras", enabled: true, position: 0 }]

    const selection = await getProviderSelection("user_1")
    expect(selection.disabled).toContain("cerebras")
  })

  it("drops unknown ids instead of handing them to the router", async () => {
    h.rows = [{ provider: "not-a-provider", enabled: true, position: 0 }]

    const selection = await getProviderSelection("user_1")
    expect(selection.order).not.toContain("not-a-provider")
  })
})

describe("saveProviderSelection", () => {
  it("writes a complete, ordered list and reads it back", async () => {
    const saved = await saveProviderSelection("user_1", {
      order: ["groq", "openrouter"],
      disabled: ["cloudflare"],
    })

    expect(h.rows).toHaveLength(5)
    expect(h.rows.map((row) => row.position)).toEqual([0, 1, 2, 3, 4])
    expect(saved.order.slice(0, 2)).toEqual(["groq", "openrouter"])
    expect(saved.disabled).toContain("cloudflare")
  })

  it("only writes providers that exist", async () => {
    await saveProviderSelection("user_1", {
      order: ["groq", "made-up"] as never,
      disabled: [],
    })

    expect(h.rows.map((row) => row.provider)).not.toContain("made-up")
    expect(h.rows).toHaveLength(5)
  })
})
