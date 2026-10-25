import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  modelAvailability,
  noteAuthFailure,
  noteFailure,
  noteQuotaExhausted,
  noteRateLimit,
  noteRequest,
  noteSuccess,
  noteUnsupportedModel,
  providerAvailability,
  quotaReport,
  resetQuotaManager,
  setQuotaClock,
  setQuotaStore,
  type QuotaState,
  type QuotaStore,
} from "../quota-manager"

const START = 1_700_000_000_000
let clock = START

beforeEach(() => {
  clock = START
  setQuotaClock(() => clock)
})

afterEach(() => {
  resetQuotaManager()
})

describe("cooldowns", () => {
  it("keeps a transient 429 short and a daily cap until its reset", () => {
    noteRateLimit("openrouter", { modelId: "m", retryAfterMs: 5_000 })
    // A per-minute limit belongs to that model, not to the whole provider.
    expect(modelAvailability("openrouter", "m")).toMatchObject({
      available: false,
      reason: "rate_limited",
      until: START + 5_000,
    })
    expect(providerAvailability("openrouter").available).toBe(true)

    // The cooldown expires on its own, without another request clearing it.
    clock = START + 5_001
    expect(modelAvailability("openrouter", "m").available).toBe(true)

    const resetsAt = new Date(START + 6 * 60 * 60 * 1000)
    noteQuotaExhausted("gemini", { resetsAt, detail: "requests per day" })
    expect(providerAvailability("gemini")).toMatchObject({
      available: false,
      reason: "quota_exhausted",
      until: resetsAt.getTime(),
    })
  })

  it("honours Retry-After but never waits less than a second", () => {
    noteRateLimit("groq", { retryAfterMs: 0 })
    expect(providerAvailability("groq").until).toBe(START + 1_000)
  })

  it("cools the provider as a whole when the 429 names no model", () => {
    noteRateLimit("gemini", { retryAfterMs: 2_000 })
    expect(providerAvailability("gemini")).toMatchObject({
      available: false,
      reason: "rate_limited",
      until: START + 2_000,
    })
  })

  it("clears a rate-limit cooldown after a success but keeps an auth block", () => {
    noteRateLimit("cerebras", { modelId: "gpt-oss-120b" })
    noteSuccess("cerebras", "gpt-oss-120b")
    expect(providerAvailability("cerebras").available).toBe(true)

    noteAuthFailure("cerebras", "abc123", "invalid key")
    noteSuccess("cerebras", "gpt-oss-120b")
    expect(providerAvailability("cerebras", "abc123")).toMatchObject({
      available: false,
      reason: "auth",
    })
  })

  it("unblocks a provider when its credentials change", () => {
    noteAuthFailure("openrouter", "old-fingerprint", "invalid key")
    expect(providerAvailability("openrouter", "old-fingerprint").available).toBe(false)
    expect(providerAvailability("openrouter", "new-fingerprint").available).toBe(true)
  })

  it("cools down one unsupported model without disabling the provider", () => {
    noteUnsupportedModel("groq", "missing-model", "model not found")

    expect(modelAvailability("groq", "missing-model").available).toBe(false)
    expect(modelAvailability("groq", "openai/gpt-oss-120b").available).toBe(true)
    expect(providerAvailability("groq").available).toBe(true)
  })
})

describe("metrics", () => {
  it("counts attempts, outcomes and tokens per provider", () => {
    noteRequest("openrouter")
    noteRequest("openrouter")
    noteSuccess("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free", {
      latencyMs: 400,
      usage: { inputTokens: 120, outputTokens: 30 },
    })
    noteFailure("openrouter", "nvidia/nemotron-3.5-lightning:free", {
      category: "timeout",
      latencyMs: 8_000,
    })
    noteRateLimit("openrouter", { modelId: "x" })

    const report = quotaReport().find((entry) => entry.provider === "openrouter")
    expect(report).toMatchObject({
      requests: 2,
      successes: 1,
      failures: 1,
      rateLimitErrors: 1,
      inputTokens: 120,
      outputTokens: 30,
      lastErrorCategory: "rate_limited",
    })
  })

  it("never mixes provider-specific units", () => {
    noteQuotaExhausted("cloudflare", { unit: "neurons", used: 10_000 })
    noteQuotaExhausted("openrouter", { used: 50 })

    const cloudflare = quotaReport().find((entry) => entry.provider === "cloudflare")
    const openrouter = quotaReport().find((entry) => entry.provider === "openrouter")

    expect(cloudflare?.units).toEqual({ neurons: 10_000 })
    expect(openrouter?.units).toEqual({})
    // Remaining free quota is not reported by the providers uniformly, so it is
    // never invented.
    expect(cloudflare?.remainingQuotaKnown).toBe(false)
  })

  it("records concurrent requests without losing any", () => {
    for (let index = 0; index < 50; index++) noteRequest("gemini")
    const report = quotaReport().find((entry) => entry.provider === "gemini")
    expect(report?.requests).toBe(50)
  })
})

describe("store adapter", () => {
  it("persists through a custom store instead of process memory", () => {
    let saved: QuotaState | null = null
    const store: QuotaStore = {
      load: () => saved,
      save: (state) => {
        saved = state
      },
    }

    setQuotaStore(store)
    noteRateLimit("groq", { retryAfterMs: 2_000 })

    const persisted = saved as QuotaState | null
    expect(persisted?.providers.groq?.cooldown?.reason).toBe("rate_limited")
    expect(providerAvailability("groq").available).toBe(false)
  })
})
