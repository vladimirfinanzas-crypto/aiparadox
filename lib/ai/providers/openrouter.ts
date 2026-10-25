import { createOpenRouter } from "@openrouter/ai-sdk-provider"

import type { ProviderAdapter } from "../types"

const KEY = "OPENROUTER_API_KEY"

function apiKey(): string | null {
  const value = process.env[KEY]?.trim()
  return value ? value : null
}

/**
 * OpenRouter stays the primary provider and keeps its exact previous behaviour:
 * the same model ids, the same free-tier `models` fallback inside one request,
 * and the same reasoning effort per role.
 *
 * Its free allowance is counted in requests per day per key, and the daily cap
 * is reported as `429 free-models-per-day`. That error is classified as an
 * exhausted daily quota, so the router stops retrying this provider and moves
 * to the next one instead of walking the whole OpenRouter ladder.
 */
export const openrouter: ProviderAdapter = {
  id: "openrouter",
  label: "OpenRouter",
  requires: [KEY],
  quotaUnit: "requests",
  note: "Primary. Free models: 50 requests/day, 1000/day with 10 credits on the account.",

  isConfigured: () => apiKey() !== null,

  missingEnv: () => (apiKey() ? [] : [KEY]),

  createModel: (modelId) => createOpenRouter({ apiKey: apiKey() ?? "" }).chat(modelId),

  callOptions: ({ effort, serverFallbackModels }) => ({
    openrouter: {
      // Reasoning is paid for in latency, so the role decides how much.
      reasoning: { effort },
      // Same-provider rungs only: the provider never jumps to a paid model.
      ...(serverFallbackModels && serverFallbackModels.length > 0
        ? { models: serverFallbackModels }
        : {}),
    },
  }),
}
