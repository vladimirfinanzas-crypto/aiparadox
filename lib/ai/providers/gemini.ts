import { createGoogleGenerativeAI } from "@ai-sdk/google"

import type { ProviderAdapter } from "../types"

const KEY = "GOOGLE_GENERATIVE_AI_API_KEY"

function apiKey(): string | null {
  const value = process.env[KEY]?.trim() ?? process.env.GOOGLE_API_KEY?.trim()
  return value ? value : null
}

/**
 * Google Gemini, through the Gemini API (not Vertex). The key is the one from
 * Google AI Studio, sent in the `x-goog-api-key` header by the SDK.
 *
 * Free-tier limits are per model, per project and change without notice; AI
 * Studio's Rate Limits page is the live source. The daily limit resets at
 * midnight Pacific time, which differs from OpenRouter's UTC reset — the quota
 * manager does not assume either.
 *
 * Only the free text models are in the catalog: `gemini-4-argon` and
 * `gemini-3.1-pro-preview` have no free tier and are never selected.
 */
export const gemini: ProviderAdapter = {
  id: "gemini",
  label: "Google Gemini",
  requires: [KEY],
  quotaUnit: "requests",
  note: "General and vision fallback. Free tier per model; limits are visible in AI Studio.",

  isConfigured: () => apiKey() !== null,

  missingEnv: () => (apiKey() ? [] : [KEY]),

  createModel: (modelId) => {
    const google = createGoogleGenerativeAI({ apiKey: apiKey() ?? "" })
    return google.chat(modelId)
  },

  callOptions: ({ effort }) => ({
    google: {
      // Gemini 3 thinks before answering by default. Interactive roles ask for
      // the lowest level: a free-tier turn that spends its whole first-output
      // deadline thinking is a failed turn.
      thinkingConfig: { thinkingLevel: effort === "medium" ? "medium" : "low" },
    },
  }),
}
