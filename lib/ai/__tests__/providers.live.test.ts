import { generateText, type LanguageModel } from "ai"
import { describe, expect, it } from "vitest"

import { classifyProviderError } from "../fallback"
import { catalogForRole } from "../models"
import { adapterFor, configuredProviders } from "../provider-registry"

/**
 * Opt-in smoke test against the real providers.
 *
 * It emits one tiny completion per configured provider, so it is skipped unless
 * someone asks for it: no test run spends quota by accident.
 *
 *   PARADOX_LIVE_PROVIDER_TESTS=1 npx vitest run lib/ai/__tests__/providers.live.test.ts
 *
 * What it proves that a mock cannot: the model ids are real on that provider
 * today, the credentials work, and the adapter speaks the provider's protocol.
 * A rate limit or a spent daily allowance is reported, not treated as a broken
 * configuration — those are capacity, and the router's job is to handle them.
 */
const enabled = process.env.PARADOX_LIVE_PROVIDER_TESTS === "1"

type LiveResult = {
  provider: string
  model: string
  ok: boolean
  ms: number
  outcome: string
}

describe.skipIf(!enabled)("live providers", () => {
  it(
    "answers from every configured provider, or says why it cannot",
    async () => {
      const providers = configuredProviders()

      // The operator asked for this test, so an empty environment is a failure:
      // it would otherwise pass without checking anything.
      expect(
        providers.length,
        "no provider is configured: set at least one API key before running the live test"
      ).toBeGreaterThan(0)

      const results: LiveResult[] = []

      for (const provider of providers) {
        const candidate = catalogForRole("general").find(
          (entry) => entry.provider === provider
        )
        expect(
          candidate,
          `${provider} has no general-role model in the catalog`
        ).toBeTruthy()
        if (!candidate) continue

        const started = Date.now()
        try {
          const result = await generateText({
            model: adapterFor(provider).createModel(
              candidate.modelId
            ) as LanguageModel,
            prompt: "Reply with exactly: OK",
            maxOutputTokens: 8,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(20_000),
            ...(provider === "openrouter" && {
              providerOptions: { openrouter: { reasoning: { effort: "none" } } },
            }),
          })

          const text = result.text.trim()
          results.push({
            provider,
            model: candidate.modelId,
            ok: text.length > 0,
            ms: Date.now() - started,
            outcome: text.length > 0 ? "answered" : "empty answer",
          })
        } catch (error) {
          const classified = classifyProviderError(error, provider)
          results.push({
            provider,
            model: candidate.modelId,
            ok: false,
            ms: Date.now() - started,
            outcome: `${classified.category}: ${classified.message}`,
          })

          // Capacity, not configuration: the next request may work
          if (
            classified.category === "quota_exhausted" ||
            classified.category === "rate_limited"
          ) {
            continue
          }

          throw new Error(
            `${provider}/${candidate.modelId} failed (${classified.category}): ${classified.message}`
          )
        }
      }

      // Printed so the operator can see each provider, not just a pass/fail
      console.table(results)

      // At least one provider has to answer for the run to mean anything
      expect(
        results.some((entry) => entry.ok),
        "no configured provider answered"
      ).toBe(true)
    },
    120_000
  )
})
