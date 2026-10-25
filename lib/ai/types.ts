/**
 * Shared vocabulary for the AI provider layer.
 *
 * Everything here is server-only: provider clients read their keys from
 * `process.env`, and no value from this module is ever sent to the browser.
 */

/** Every AI provider Paradox can talk to. */
export const PROVIDER_IDS = [
  "openrouter",
  "gemini",
  "cerebras",
  "groq",
  "cloudflare",
] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

/** What a model can do, as far as the provider documents it. */
export const MODEL_CAPABILITIES = [
  "streaming",
  "tools",
  "structuredOutput",
  "vision",
] as const

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number]

/**
 * The job a model is chosen for. These are the roles from `lib/model.ts`, plus
 * `reasoner` for multistep reasoning that is not code and not chat.
 */
export const MODEL_ROLES = [
  "general",
  "fast",
  "code",
  "reasoner",
  "creative",
  "vision",
  "evaluator",
] as const

export type ModelRole = (typeof MODEL_ROLES)[number]

/**
 * What a role needs from a model. The router filters candidates by these, so a
 * provider is never asked for a capability its model does not document.
 */
export type ModelRequirements = Partial<Record<ModelCapability, boolean>>

/** One model, on one provider, with the capabilities it was verified to have. */
export type ModelCandidate = {
  provider: ProviderId
  /** The provider's own model id, exactly as documented. */
  modelId: string
  capabilities: readonly ModelCapability[]
  /** True when the model is billed on a free tier / free allocation. */
  freeTier: boolean
  /** Where this candidate came from, for diagnostics. */
  source?: "catalog" | "override" | "backstop"
  /** Short human note: why this rung exists. */
  note?: string
}

/** A candidate with its provider options resolved, ready to be called. */
export type ProviderModel = {
  /** The AI SDK language model. */
  model: unknown
  /** Provider options merged into every call of this candidate. */
  providerOptions?: Record<string, Record<string, unknown>>
  /**
   * Same-provider models the provider may fall back to on its own, e.g.
   * OpenRouter's `models` field. Never contains another provider.
   */
  serverFallbackModels?: string[]
}

/** Health of one provider's configuration, without exposing any secret. */
export type ProviderConfiguration = {
  id: ProviderId
  label: string
  configured: boolean
  /** Env var names this provider needs, never their values. */
  requires: readonly string[]
  missing: readonly string[]
  /** Model ids the catalog can reach on this provider. */
  models: string[]
  /** How this provider's free allocation is measured. */
  quotaUnit: "requests" | "neurons" | "tokens" | "credits"
  note: string
}

/**
 * The AI SDK language-model shape, narrowed to what this layer touches.
 *
 * The real type lives in `@ai-sdk/provider`; redeclaring the handful of fields
 * the router needs keeps the wrapper in one place and avoids depending on a
 * transitive package.
 */
export type AiCallOptions = {
  abortSignal?: AbortSignal
  providerOptions?: Record<string, Record<string, unknown>>
  [key: string]: unknown
}

export type AiStreamPart = {
  type: string
  error?: unknown
  [key: string]: unknown
}

export type AiStreamResult = {
  stream: ReadableStream<AiStreamPart>
  warnings?: unknown[]
  request?: { body?: unknown }
  response?: unknown
}

export type AiGenerateResult = {
  content: unknown[]
  finishReason?: unknown
  usage?: unknown
  warnings?: unknown[]
  request?: unknown
  response?: unknown
}

export type AiLanguageModel = {
  readonly specificationVersion: "v4"
  readonly provider: string
  readonly modelId: string
  supportedUrls:
    | Record<string, RegExp[]>
    | PromiseLike<Record<string, RegExp[]>>
  doGenerate(options: AiCallOptions): PromiseLike<AiGenerateResult>
  doStream(options: AiCallOptions): PromiseLike<AiStreamResult>
}

/** How much thinking a reasoning-capable model is asked to spend. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium"

/**
 * One provider, as the router sees it. Adapters are the only place a provider
 * SDK is touched, so adding a provider never reaches the agent code.
 */
export type ProviderAdapter = {
  id: ProviderId
  label: string
  /** Env var names this provider needs, never values. */
  requires: readonly string[]
  /** How its free allocation is counted. Never mixed with another provider's. */
  quotaUnit: "requests" | "neurons" | "tokens" | "credits"
  /** One line for docs and startup logs. */
  note: string
  isConfigured(): boolean
  /** Env names missing from the current environment. */
  missingEnv(): string[]
  /** Builds the provider's own language model. */
  createModel(modelId: string): unknown
  /** Provider-specific options merged into every call. */
  callOptions?(args: {
    modelId: string
    role: ModelRole
    effort: ReasoningEffort
    serverFallbackModels?: string[]
  }): Record<string, Record<string, unknown>> | undefined
}

/** Token counts a provider reports, when it reports any. */
export type UsageInfo = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** Millionths of a dollar, when a price is known. */
  costMicros?: number
  /**
   * Provider-specific units returned with the usage, e.g. Workers AI's
   * `{ neurons: 1.47 }`. Kept apart from tokens on purpose.
   */
  units?: Record<string, number>
}
