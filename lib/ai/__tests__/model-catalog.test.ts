import { describe, expect, it } from "vitest"

import { planForRole } from "../model-router"

// The OpenRouter catalogue advertises `response_format` (loose JSON) and
// `structured_outputs` (strict json_schema) separately, per model. A model with
// only the first was catalogued as if it had the second, so a strict-schema call
// could be planned onto it and then fail at the provider — one wasted call and a
// fallback that looked like an outage.
describe("catalog capabilities", () => {
  it("plans a strict-schema call only on models that document it", () => {
    const plan = planForRole("general", {
      requirements: { structuredOutput: true },
    })
    const eligible = plan.candidates.map(
      (entry) => `${entry.provider}:${entry.modelId}`
    )

    // dots-3-note-preview is the free OpenRouter model with structured_outputs
    expect(eligible).toContain("openrouter:dots-studio/dots-3-note-preview:free")
    // These two only have loose JSON mode
    expect(eligible).not.toContain(
      "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free"
    )
    expect(eligible).not.toContain("openrouter:google/gemma-4-31b-it:free")

    // …and they are reported as unsupported, not silently dropped
    expect(
      plan.unsupported.some(
        (entry) =>
          entry.candidate.modelId === "nvidia/nemotron-3-ultra-550b-a55b:free" &&
          entry.missing.includes("structuredOutput")
      )
    ).toBe(true)
  })

  it("keeps those models usable for ordinary chat turns", () => {
    // Tools + streaming, no schema: the main chat role must still use them
    const plan = planForRole("general")
    const eligible = plan.candidates.map((entry) => entry.modelId)

    expect(eligible).toContain("nvidia/nemotron-3-ultra-550b-a55b:free")
    expect(eligible[0]).toBe("nvidia/nemotron-3-ultra-550b-a55b:free")
  })

  it("never plans a vision call on a model without image input", () => {
    const plan = planForRole("vision")

    expect(plan.candidates.length).toBeGreaterThan(0)
    for (const entry of plan.candidates) {
      expect(entry.capabilities).toContain("vision")
    }
  })
})
