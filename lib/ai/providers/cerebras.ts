import { createCerebras } from "@ai-sdk/cerebras"

import type { ProviderAdapter } from "../types"

const KEY = "CEREBRAS_API_KEY"

function apiKey(): string | null {
  const value = process.env[KEY]?.trim()
  return value ? value : null
}

/**
 * Cerebras Inference (https://api.cerebras.ai/v1). Its free trial is measured
 * in tokens, not requests — 5 requests/min, 30K uncached tokens/min, 1M
 * tokens/day per model on the shared tier — and it is bounded by trial credits
 * rather than an endlessly renewing allowance. That is why this adapter reports
 * `tokens` as its quota unit and why the quota manager keeps it separate from
 * request-counted providers.
 *
 * The catalog only uses shared-inference models: `gpt-oss-120b` and
 * `qwen-3.8-27b` (the only image-capable shared model).
 */
export const cerebras: ProviderAdapter = {
  id: "cerebras",
  label: "Cerebras",
  requires: [KEY],
  quotaUnit: "tokens",
  note: "Very fast inference. Token-bounded free trial, not a request quota.",

  isConfigured: () => apiKey() !== null,

  missingEnv: () => (apiKey() ? [] : [KEY]),

  createModel: (modelId) => createCerebras({ apiKey: apiKey() ?? "" })(modelId),
}
