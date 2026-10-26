import { afterEach, describe, expect, it } from "vitest"

import { checkAiHealth } from "@/lib/ai-health"

// The health endpoint is the diagnostic for "Godfather no responde", so it has to
// answer without credentials too — and it has to say which providers were probed
// and how much time the probes were given.
const PROVIDER_ENV = [
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "CEREBRAS_API_KEY",
  "GROQ_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
]

const original = Object.fromEntries(
  PROVIDER_ENV.map((name) => [name, process.env[name]])
)

function clearProviderEnv() {
  for (const name of PROVIDER_ENV) delete process.env[name]
}

describe("AI health", () => {
  afterEach(() => {
    for (const name of PROVIDER_ENV) {
      const value = original[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it("reports an unconfigured runtime without calling anything", async () => {
    clearProviderEnv()

    const health = await checkAiHealth({ probe: true })

    expect(health.keyConfigured).toBe(false)
    expect(health.catalogueError).toMatch(/OPENROUTER_API_KEY/)
    // Nothing is configured, so nothing is guessed at or called
    expect(health.providerProbes).toEqual([])
    // The budget is stated, so a caller knows why a probe may be missing
    expect(health.probeBudgetMs).toBeGreaterThan(0)
    expect(health.providers.every((entry) => entry.configured === false)).toBe(
      true
    )
  })

  it("describes the routing plan for every role", async () => {
    clearProviderEnv()

    const health = await checkAiHealth()

    expect(health.routing.length).toBe(health.roles.length)
    for (const role of health.routing) {
      expect(Array.isArray(role.candidates)).toBe(true)
      expect(Array.isArray(role.required)).toBe(true)
    }
    // No probes were asked for, so none are reported
    expect(health.probes).toBeUndefined()
    expect(health.providerProbes).toBeUndefined()
  })
})
