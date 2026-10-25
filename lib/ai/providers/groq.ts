import { createGroq } from "@ai-sdk/groq"

import type { ProviderAdapter } from "../types"

const KEY = "GROQ_API_KEY"

function apiKey(): string | null {
  const value = process.env[KEY]?.trim()
  return value ? value : null
}

/**
 * Groq (https://api.groq.com/openai/v1). Fast Llama and GPT-OSS inference.
 *
 * Rate limits are per organisation and exposed on the account's Limits page;
 * each response carries `x-ratelimit-*` headers, and 429s carry `retry-after`.
 * `x-ratelimit-remaining-requests` reaching 0 is Groq's requests-per-day signal,
 * which the classifier treats as an exhausted daily quota — a momentary
 * per-minute 429 is handled as a short cooldown instead.
 *
 * `json_schema` is only offered by the GPT-OSS models (and cannot be combined
 * with streaming or tool use), while the Llama models only support
 * `json_object`; the catalog marks them accordingly.
 */
export const groq: ProviderAdapter = {
  id: "groq",
  label: "Groq",
  requires: [KEY],
  quotaUnit: "requests",
  note: "Fast text and tool use. Limits per organisation, reported in rate-limit headers.",

  isConfigured: () => apiKey() !== null,

  missingEnv: () => (apiKey() ? [] : [KEY]),

  createModel: (modelId) => createGroq({ apiKey: apiKey() ?? "" })(modelId),

  callOptions: ({ effort }) => ({
    groq: {
      // GPT-OSS reasons by default, and reasoning tokens are billed against the
      // output budget. Low effort keeps interactive turns fast; only code and
      // reasoning ask for more.
      reasoningEffort: effort === "medium" ? "medium" : "low",
    },
  }),
}
