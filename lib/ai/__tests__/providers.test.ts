import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  MODEL_CONFIG,
  MODEL_LADDERS,
  catalogForRole,
  missingCapabilities,
  modelRoleForAgentKind,
  providerOrder,
  ROLE_REQUIREMENTS,
} from "../models"
import { fixCloudflareSseLine } from "../providers/cloudflare"
import {
  aiProviderStartupReport,
  providerConfigurations,
  resolveCandidate,
} from "../provider-registry"
import { MODEL_ROLES } from "../types"

const AI_ENV = [
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "CEREBRAS_API_KEY",
  "GROQ_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "OPENROUTER_BACKSTOP_MODEL",
  "PARADOX_PROVIDER_ORDER",
  "PARADOX_DISABLED_PROVIDERS",
  "PARADOX_ALLOW_PAID_MODELS",
] as const

beforeEach(() => {
  for (const name of AI_ENV) vi.stubEnv(name, "")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("model catalog", () => {
  it("keeps the existing OpenRouter ids as the first rung", () => {
    for (const role of MODEL_ROLES) {
      const candidates = catalogForRole(role)
      const firstOpenRouter = candidates.find((entry) => entry.provider === "openrouter")
      expect(firstOpenRouter?.modelId).toBe(MODEL_LADDERS[role][0])
    }
  })

  it("covers every role in the default provider order", () => {
    expect(providerOrder()).toEqual([
      "openrouter",
      "gemini",
      "cerebras",
      "groq",
      "cloudflare",
    ])

    const general = catalogForRole("general").map((entry) => entry.provider)
    expect(general.indexOf("openrouter")).toBeLessThan(general.indexOf("gemini"))
    expect(general.indexOf("gemini")).toBeLessThan(general.indexOf("cerebras"))
    expect(general.indexOf("cerebras")).toBeLessThan(general.indexOf("groq"))
    expect(general.indexOf("groq")).toBeLessThan(general.indexOf("cloudflare"))
  })

  it("declares capabilities honestly and never needs a paid model", () => {
    for (const role of MODEL_ROLES) {
      for (const entry of catalogForRole(role)) {
        expect(entry.capabilities).toContain("streaming")
        // Every catalogued model is on a free tier unless an operator names a
        // backstop.
        expect(entry.freeTier).toBe(true)
      }
    }
  })

  it("offers image input only where the provider documents it", () => {
    const vision = catalogForRole("vision")
    expect(vision.some((entry) => entry.capabilities.includes("vision"))).toBe(true)

    // The first general candidate is OpenRouter's text model: it must be
    // reported as missing vision rather than quietly accepting an image.
    const general = catalogForRole("general")[0]
    expect(missingCapabilities(general, { vision: true })).toEqual(["vision"])
  })

  it("maps agent kinds to the roles the product promises", () => {
    expect(modelRoleForAgentKind("chat")).toBe("general")
    expect(modelRoleForAgentKind("browser")).toBe("fast")
    expect(modelRoleForAgentKind("computer")).toBe("vision")
    expect(modelRoleForAgentKind("social")).toBe("creative")
    expect(modelRoleForAgentKind(undefined)).toBe("general")
    expect(MODEL_CONFIG.general).toContain(":free")
    expect(ROLE_REQUIREMENTS.vision.vision).toBe(true)
  })
})

describe("configuration overrides", () => {
  it("puts an operator-chosen model first and disables providers on request", () => {
    vi.stubEnv("PARADOX_MODEL_GENERAL", "gemini:gemini-3.8-flash")
    vi.stubEnv("PARADOX_PROVIDER_ORDER", "gemini,openrouter")
    vi.stubEnv("PARADOX_DISABLED_PROVIDERS", "groq,cloudflare")

    const candidates = catalogForRole("general")
    expect(candidates[0]).toMatchObject({
      provider: "gemini",
      modelId: "gemini-3.8-flash",
      source: "override",
    })

    const providers = candidates.map((entry) => entry.provider)
    expect(providers).not.toContain("groq")
    expect(providers).not.toContain("cloudflare")
    expect(providers.indexOf("gemini")).toBeLessThan(providers.indexOf("openrouter"))
  })

  it("appends the explicitly configured OpenRouter backstop last", () => {
    vi.stubEnv("OPENROUTER_BACKSTOP_MODEL", "openai/gpt-some-paid-model")

    const candidates = catalogForRole("general")
    const last = candidates.at(-1)
    expect(last).toMatchObject({
      provider: "openrouter",
      modelId: "openai/gpt-some-paid-model",
      freeTier: false,
      source: "backstop",
    })
  })
})

describe("Workers AI stream repair", () => {
  it("turns a numeric content chunk into a string and leaves everything else alone", () => {
    expect(
      fixCloudflareSseLine('data: {"choices":[{"delta":{"content":1}}]}')
    ).toBe('data: {"choices":[{"delta":{"content":"1"}}]}')

    const text = 'data: {"choices":[{"delta":{"content":"ok"}}]}'
    expect(fixCloudflareSseLine(text)).toBe(text)
    expect(fixCloudflareSseLine("data: [DONE]")).toBe("data: [DONE]")
    expect(fixCloudflareSseLine("event: ping")).toBe("event: ping")
    expect(fixCloudflareSseLine("data: not json")).toBe("data: not json")
  })
})

describe("provider configuration", () => {
  it("reports missing variables by name, never by value", () => {
    const configuration = providerConfigurations()
    const gemini = configuration.find((entry) => entry.id === "gemini")
    expect(gemini?.configured).toBe(false)
    expect(gemini?.missing).toEqual(["GOOGLE_GENERATIVE_AI_API_KEY"])

    const cloudflare = configuration.find((entry) => entry.id === "cloudflare")
    expect(cloudflare?.missing).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
    ])
    expect(cloudflare?.quotaUnit).toBe("neurons")

    const report = aiProviderStartupReport()
    expect(report.configured).toEqual([])
    expect(report.summary).toContain("gemini=skipped(GOOGLE_GENERATIVE_AI_API_KEY)")
    expect(report.summary).not.toContain("sk-")
  })

  it("marks one provider ready when only its key is present", () => {
    vi.stubEnv("GROQ_API_KEY", "test-key-not-a-real-credential")

    const report = aiProviderStartupReport()
    expect(report.configured).toEqual(["groq"])
    expect(report.missing.groq).toBeUndefined()
    expect(report.summary).toContain("groq=ready")
  })

  it("refuses to build a model for an unconfigured provider", () => {
    const geminiCandidate = catalogForRole("general").find(
      (entry) => entry.provider === "gemini"
    )
    expect(geminiCandidate).toBeDefined()

    const resolved = resolveCandidate(geminiCandidate!, "general")
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) {
      expect(resolved.reason).toBe("unconfigured")
      expect(resolved.detail).toContain("GOOGLE_GENERATIVE_AI_API_KEY")
    }
  })
})
