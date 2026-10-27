import {
  MODEL_ROLES,
  PROVIDER_IDS,
  type ModelCandidate,
  type ModelCapability,
  type ModelRequirements,
  type ModelRole,
  type ProviderId,
  type ReasoningEffort,
} from "./types"

/**
 * The model catalog: which model each role tries, in which order, and what each
 * model can actually do.
 *
 * Sources are the providers' own catalogs (checked October 2026):
 *   - Gemini API models:      https://ai.google.dev/gemini-api/docs/models
 *   - Gemini pricing (free):  https://ai.google.dev/gemini-api/docs/pricing
 *   - Cerebras model catalog: https://inference-docs.cerebras.ai/models/overview
 *   - Groq supported models:  https://console.groq.com/docs/models
 *   - Cloudflare models:      https://developers.cloudflare.com/workers-ai/models/
 *
 * Capabilities are deliberately conservative: a model is only marked for a
 * capability its provider documents. The router refuses to send a task to a
 * model that lacks one, instead of degrading silently.
 *
 * Nothing here is permanent. Every id can be replaced without touching
 * application logic — see `PARADOX_MODEL_<ROLE>` below — because free tiers,
 * model names and limits change.
 */

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  gemini: "Google Gemini",
  cerebras: "Cerebras",
  groq: "Groq",
  cloudflare: "Cloudflare Workers AI",
}

/** The default routing order. `PARADOX_PROVIDER_ORDER` can change it. */
export const DEFAULT_PROVIDER_ORDER: ProviderId[] = [...PROVIDER_IDS]

/** How each provider's free allocation is counted. Never mixed together. */
export const PROVIDER_QUOTA_UNITS: Record<ProviderId, "requests" | "neurons" | "tokens" | "credits"> = {
  openrouter: "requests",
  gemini: "requests",
  cerebras: "tokens",
  groq: "requests",
  // Workers AI's free allowance is 10,000 Neurons a day, not a request count.
  cloudflare: "neurons",
}

// ---------------------------------------------------------------------------
// Capability shorthands
// ---------------------------------------------------------------------------

const TEXT: readonly ModelCapability[] = ["streaming", "tools", "structuredOutput"]
const MULTIMODAL: readonly ModelCapability[] = [...TEXT, "vision"]

// OpenRouter advertises `response_format` (loose JSON mode) and
// `structured_outputs` (strict json_schema) separately, and the live catalogue
// lists them per model. `structuredOutput` in this catalog means the strict one,
// the same rule Groq's models are held to below — so a model that only has
// `response_format` is built with one of these instead of `TEXT`.
const TEXT_LOOSE_JSON: readonly ModelCapability[] = ["streaming", "tools"]
const MULTIMODAL_LOOSE_JSON: readonly ModelCapability[] = ["streaming", "tools", "vision"]

function candidate(
  provider: ProviderId,
  modelId: string,
  capabilities: readonly ModelCapability[],
  note?: string
): ModelCandidate {
  return { provider, modelId, capabilities, freeTier: true, source: "catalog", note }
}

// ---------------------------------------------------------------------------
// The OpenRouter ids Paradox already ran on. Kept first in every ladder so the
// current behaviour — and the dashboard that lists them — is unchanged.
// ---------------------------------------------------------------------------

export const MODEL_CONFIG = {
  general: "nvidia/nemotron-3-ultra-550b-a55b:free",
  fast: "nvidia/nemotron-3.5-lightning:free",
  code: "nvidia/nemotron-3-ultra-550b-a55b:free",
  reasoner: "nvidia/nemotron-3-ultra-550b-a55b:free",
  creative: "dots-studio/dots-3-note-preview:free",
  vision: "nvidia/nemotron-3.5-super-vl:free",
  evaluator: "dots-studio/dots-3-note-preview:free",
} as const satisfies Record<ModelRole, string>

const OR_GENERAL = MODEL_CONFIG.general
const OR_FAST = MODEL_CONFIG.fast
const OR_CREATIVE = MODEL_CONFIG.creative
const OR_VISION = MODEL_CONFIG.vision
const OR_EVALUATOR = MODEL_CONFIG.evaluator
const OR_DOTS = "dots-studio/dots-3-note-preview:free"
// MiniMax M3.1 Flash's free variant was retired on 2026-10-22. Gemma 4 takes
// its place as the free multimodal rung; it is rate-limited upstream at times,
// which is why it sits behind a model that answers, never in front of one.
const OR_MULTIMODAL = "google/gemma-4-31b-it:free"

/**
 * OpenRouter ladders, unchanged from the previous release. They stay exported
 * for the dashboard and for the health check, which reads OpenRouter's catalogue
 * by id.
 */
export const MODEL_LADDERS: Record<ModelRole, string[]> = {
  general: [OR_GENERAL, OR_MULTIMODAL, OR_DOTS],
  fast: [OR_FAST, OR_DOTS, OR_GENERAL],
  code: [MODEL_CONFIG.code, OR_MULTIMODAL, OR_DOTS],
  reasoner: [MODEL_CONFIG.reasoner, OR_MULTIMODAL, OR_DOTS],
  vision: [OR_VISION, OR_MULTIMODAL, OR_DOTS],
  creative: [OR_DOTS, OR_GENERAL, OR_MULTIMODAL],
  evaluator: [OR_EVALUATOR, OR_GENERAL, OR_VISION],
}

// ---------------------------------------------------------------------------
// Cross-provider catalog
// ---------------------------------------------------------------------------

// Capabilities below are the ones the live catalogue reports for each id
// (`supported_parameters`). Where a model has tools but only loose JSON mode, it
// carries TEXT_LOOSE_JSON: it can run an agent turn, but it is not a candidate
// for a call that needs a strict schema.
const OPENROUTER_MODELS: Record<ModelRole, ModelCandidate[]> = {
  general: [
    candidate("openrouter", OR_GENERAL, TEXT_LOOSE_JSON, "Best free reasoning of the set"),
    candidate("openrouter", OR_MULTIMODAL, MULTIMODAL_LOOSE_JSON, "Creative and multimodal"),
    candidate("openrouter", OR_DOTS, TEXT, "Honours a strict JSON schema"),
  ],
  fast: [
    candidate("openrouter", OR_FAST, TEXT_LOOSE_JSON, "~270ms, but spends tokens on reasoning"),
    candidate("openrouter", OR_DOTS, TEXT, "Fast structured answers"),
    candidate("openrouter", OR_GENERAL, TEXT_LOOSE_JSON, "Stronger when the fast rung stalls"),
  ],
  code: [
    candidate("openrouter", MODEL_CONFIG.code, TEXT_LOOSE_JSON, "Best free reasoning of the set"),
    candidate("openrouter", OR_MULTIMODAL, MULTIMODAL_LOOSE_JSON),
    candidate("openrouter", OR_DOTS, TEXT),
  ],
  reasoner: [
    candidate("openrouter", MODEL_CONFIG.reasoner, TEXT_LOOSE_JSON),
    candidate("openrouter", OR_MULTIMODAL, MULTIMODAL_LOOSE_JSON),
    candidate("openrouter", OR_DOTS, TEXT),
  ],
  creative: [
    candidate("openrouter", OR_CREATIVE, MULTIMODAL),
    candidate("openrouter", OR_DOTS, TEXT),
    candidate("openrouter", OR_GENERAL, TEXT_LOOSE_JSON),
  ],
  vision: [
    candidate("openrouter", OR_VISION, MULTIMODAL),
    candidate("openrouter", OR_MULTIMODAL, MULTIMODAL_LOOSE_JSON),
    candidate("openrouter", OR_DOTS, TEXT, "No image input: only usable for vision fallbacks that carry text"),
  ],
  evaluator: [
    candidate("openrouter", OR_EVALUATOR, TEXT),
    candidate("openrouter", OR_GENERAL, TEXT_LOOSE_JSON),
    candidate("openrouter", OR_VISION, MULTIMODAL),
  ],
}

// Gemini API. These four are the free-of-charge text models; `gemini-3.1-pro-preview`
// and `gemini-4-argon` are intentionally absent because they have no free tier.
const GEMINI_MODELS: Record<ModelRole, ModelCandidate[]> = {
  // 3.6 Flash leads because 3.8 Flash answered "currently experiencing high
  // demand" repeatedly in live checks; 3.8 stays as the second rung.
  general: [
    candidate("gemini", "gemini-3.6-flash", MULTIMODAL, "Free tier, tools, JSON, images"),
    candidate("gemini", "gemini-3.8-flash", MULTIMODAL, "Free tier, strongest Flash"),
    candidate("gemini", "gemini-3.5-flash-lite", MULTIMODAL, "Free tier, cheaper"),
  ],
  fast: [
    candidate("gemini", "gemini-3.5-flash-lite", MULTIMODAL, "Free tier, high-volume"),
    candidate("gemini", "gemini-3.1-flash-lite", MULTIMODAL, "Free tier, classification"),
    candidate("gemini", "gemini-3.8-flash", MULTIMODAL),
  ],
  code: [
    candidate("gemini", "gemini-3.6-flash", MULTIMODAL, "Documented for software engineering"),
    candidate("gemini", "gemini-3.8-flash", MULTIMODAL),
  ],
  reasoner: [
    candidate("gemini", "gemini-3.6-flash", MULTIMODAL),
    candidate("gemini", "gemini-3.8-flash", MULTIMODAL),
  ],
  creative: [
    candidate("gemini", "gemini-3.6-flash", MULTIMODAL),
    candidate("gemini", "gemini-3.8-flash", MULTIMODAL),
  ],
  vision: [
    candidate("gemini", "gemini-3.6-flash", MULTIMODAL, "Image input with tools and JSON"),
    candidate("gemini", "gemini-3.8-flash", MULTIMODAL),
    candidate("gemini", "gemini-3.5-flash-lite", MULTIMODAL),
  ],
  evaluator: [
    candidate("gemini", "gemini-3.1-flash-lite", MULTIMODAL, "Fast JSON answers"),
    candidate("gemini", "gemini-3.5-flash-lite", MULTIMODAL),
  ],
}

// Cerebras shared inference: a token-bounded free trial, not a request quota.
const CEREBRAS_MODELS: Record<ModelRole, ModelCandidate[]> = {
  general: [
    candidate("cerebras", "gpt-oss-120b", TEXT, "67K free context, tools + JSON schema"),
    candidate("cerebras", "qwen-3.8-27b", MULTIMODAL),
  ],
  fast: [
    candidate("cerebras", "gpt-oss-120b", TEXT, "Very fast inference"),
    candidate("cerebras", "qwen-3.8-27b", MULTIMODAL),
  ],
  code: [
    candidate("cerebras", "gpt-oss-120b", TEXT),
    candidate("cerebras", "qwen-3.8-27b", MULTIMODAL),
  ],
  reasoner: [
    candidate("cerebras", "gpt-oss-120b", TEXT),
    candidate("cerebras", "qwen-3.8-27b", MULTIMODAL),
  ],
  creative: [
    candidate("cerebras", "qwen-3.8-27b", MULTIMODAL),
    candidate("cerebras", "gpt-oss-120b", TEXT),
  ],
  vision: [candidate("cerebras", "qwen-3.8-27b", MULTIMODAL, "Only image-capable shared model")],
  evaluator: [
    candidate("cerebras", "gpt-oss-120b", TEXT, "Strict JSON schema"),
    candidate("cerebras", "qwen-3.8-27b", MULTIMODAL),
  ],
}

// Groq. The account's catalogue is deliberately small: GPT-OSS and Qwen only.
// `json_object` is not the same as `json_schema`, so only the GPT-OSS models are
// marked for structured output.
const GROQ_MODELS: Record<ModelRole, ModelCandidate[]> = {
  general: [
    candidate("groq", "openai/gpt-oss-120b", TEXT, "Tools + strict JSON schema"),
    candidate("groq", "openai/gpt-oss-20b", TEXT, "Faster, smaller"),
  ],
  fast: [
    candidate("groq", "openai/gpt-oss-20b", TEXT, "~1000 tok/s"),
    candidate("groq", "openai/gpt-oss-120b", TEXT),
  ],
  code: [
    candidate("groq", "openai/gpt-oss-120b", TEXT),
    candidate("groq", "openai/gpt-oss-20b", TEXT),
  ],
  reasoner: [
    candidate("groq", "openai/gpt-oss-120b", TEXT),
    candidate("groq", "openai/gpt-oss-20b", TEXT),
  ],
  creative: [
    candidate("groq", "openai/gpt-oss-120b", TEXT),
    candidate("groq", "qwen/qwen3.8-27b", MULTIMODAL),
  ],
  vision: [
    candidate("groq", "qwen/qwen3.8-27b", MULTIMODAL, "Vision, tools, JSON (3 images/request)"),
  ],
  evaluator: [
    candidate("groq", "openai/gpt-oss-20b", TEXT, "Strict JSON schema"),
    candidate("groq", "openai/gpt-oss-120b", TEXT),
  ],
}

// Cloudflare Workers AI. Used as the last resort and for lightweight auxiliary
// work: its free allowance is measured in Neurons, not requests.
//
// JSON mode is documented but cannot guarantee a requested schema (a live check
// returned a function-shaped object for a strict schema), so these models are
// not marked for structured output. They stay eligible for tool-calling chat,
// browser steps and screenshot reading, which is where they were verified.
const CF_TEXT: readonly ModelCapability[] = ["streaming", "tools"]
const CF_VISION: readonly ModelCapability[] = ["streaming", "tools", "vision"]

const CLOUDFLARE_MODELS: Record<ModelRole, ModelCandidate[]> = {
  general: [candidate("cloudflare", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", CF_TEXT, "Function calling")],
  fast: [candidate("cloudflare", "@cf/zai-org/glm-4.7-flash", CF_TEXT, "Built for multi-turn tool calling")],
  code: [candidate("cloudflare", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", CF_TEXT)],
  reasoner: [candidate("cloudflare", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", CF_TEXT)],
  creative: [candidate("cloudflare", "@cf/zai-org/glm-4.7-flash", CF_TEXT)],
  vision: [candidate("cloudflare", "@cf/meta/llama-4-scout-17b-16e-instruct", CF_VISION, "Vision + function calling")],
  evaluator: [candidate("cloudflare", "@cf/zai-org/glm-4.7-flash", CF_TEXT, "JSON mode only: no strict schema")],
}

/**
 * Every candidate for every role, grouped by provider so the default order is
 * the documented one: OpenRouter, Gemini, Cerebras, Groq, Cloudflare.
 */
const BY_PROVIDER: Record<ProviderId, Record<ModelRole, ModelCandidate[]>> = {
  openrouter: OPENROUTER_MODELS,
  gemini: GEMINI_MODELS,
  cerebras: CEREBRAS_MODELS,
  groq: GROQ_MODELS,
  cloudflare: CLOUDFLARE_MODELS,
}

/** What each role must be able to do. Never broaden this to "just text". */
export const ROLE_REQUIREMENTS: Record<ModelRole, ModelRequirements> = {
  // Chat turns and agent work: tools, no schema. Structured output is requested
  // explicitly by the two call sites that need it (`evaluator` for routing,
  // `structuredChatModel` for drafting agents), so a tools-capable model that
  // cannot honour a schema is still usable for conversation.
  general: { streaming: true, tools: true },
  fast: { streaming: true, tools: true },
  code: { streaming: true, tools: true },
  reasoner: { streaming: true, tools: true },
  creative: { streaming: true, tools: true },
  // The computer agent reads screenshots.
  vision: { streaming: true, tools: true, vision: true },
  // Routing and evaluation return a JSON object, never tools.
  evaluator: { streaming: true, structuredOutput: true },
}

/**
 * How long each rung may take to produce its first output before the next one
 * is tried. A model that has started answering is never interrupted, so these
 * bound "never answers", not the length of a healthy answer.
 */
export const ROLE_DEADLINES: Record<ModelRole, number[]> = {
  general: [20_000, 15_000, 15_000],
  fast: [8_000, 10_000, 12_000],
  code: [25_000, 15_000, 15_000],
  reasoner: [25_000, 15_000, 15_000],
  creative: [20_000, 15_000, 15_000],
  vision: [15_000, 12_000, 12_000],
  // Routing must fit inside the caller's own budget: `pickAgent` gives the
  // whole decision 4.5s (ROUTING_DEADLINE_MS in lib/agent-router.ts). Rungs that
  // add up to more than that can never reach a fallback — the outer signal
  // aborts the ladder first — so these three sum to 4.5s on purpose.
  evaluator: [2_000, 1_000, 1_000],
}

/**
 * Reasoning effort per role. Free models think before answering and thinking is
 * paid for in seconds, so interactive roles keep it short while code and
 * reasoning keep enough room to work.
 */
export function roleEffort(role: ModelRole): ReasoningEffort {
  switch (role) {
    case "fast":
    case "evaluator":
      return "minimal"
    case "code":
    case "reasoner":
      return "medium"
    default:
      return "low"
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function envValue(name: string): string | null {
  const value = process.env[name]?.trim()
  return value ? value : null
}

/** `PARADOX_PROVIDER_ORDER=gemini,openrouter,groq` reorders the default. */
export function providerOrder(): ProviderId[] {
  const override = envValue("PARADOX_PROVIDER_ORDER")
  if (!override) return [...DEFAULT_PROVIDER_ORDER]

  const known = new Set<ProviderId>(PROVIDER_IDS)
  const parsed = override
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is ProviderId => known.has(entry as ProviderId))

  // Unknown or missing providers keep their documented position at the end.
  return [
    ...parsed.filter((entry, index) => parsed.indexOf(entry) === index),
    ...DEFAULT_PROVIDER_ORDER.filter((entry) => !parsed.includes(entry)),
  ]
}

/** Providers an operator has switched off, without removing their keys. */
export function disabledProviders(): Set<ProviderId> {
  const value = envValue("PARADOX_DISABLED_PROVIDERS")
  if (!value) return new Set()
  const known = new Set<ProviderId>(PROVIDER_IDS)
  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry): entry is ProviderId => known.has(entry as ProviderId))
  )
}

/**
 * Paid endpoints stay off unless an operator turns them on. The OpenRouter
 * backstop is its own explicit opt-in: naming a model there authorizes it.
 */
export function allowPaidModels(): boolean {
  return envValue("PARADOX_ALLOW_PAID_MODELS")?.toLowerCase() === "true"
}

/** An optional paid OpenRouter model, appended to every OpenRouter ladder. */
export function backstopModel(): string | null {
  return envValue("OPENROUTER_BACKSTOP_MODEL")
}

function overrideCapabilities(role: ModelRole): ModelCapability[] {
  const required = Object.entries(ROLE_REQUIREMENTS[role])
    .filter(([, needed]) => needed)
    .map(([capability]) => capability as ModelCapability)
  // An operator override is assumed to do what its role needs; if it cannot,
  // the provider's own error is reported honestly instead of silently ignored.
  return required
}

/**
 * `PARADOX_MODEL_GENERAL=gemini:gemini-3.8-flash` puts that model first for the
 * role. The value is `provider:model`; a bare id means OpenRouter.
 */
function roleOverride(role: ModelRole): ModelCandidate | null {
  const raw = envValue(`PARADOX_MODEL_${role.toUpperCase()}`)
  if (!raw) return null

  const known = new Set<ProviderId>(PROVIDER_IDS)
  const separator = raw.indexOf(":")
  const maybeProvider = separator > 0 ? raw.slice(0, separator).trim().toLowerCase() : ""
  const hasProvider = known.has(maybeProvider as ProviderId)

  return {
    provider: hasProvider ? (maybeProvider as ProviderId) : "openrouter",
    modelId: (hasProvider ? raw.slice(separator + 1) : raw).trim(),
    capabilities: overrideCapabilities(role),
    // Explicit operator configuration: this is the authorization to use it,
    // even when it is a paid model.
    freeTier: true,
    source: "override",
    note: "operator override",
  }
}

/**
 * What a person chose in the integration centre, applied on top of the
 * environment (see `lib/ai/provider-settings.ts`). Passed in rather than read
 * here: this module must stay free of database access, and the chat task already
 * knows whose turn it is.
 */
export type ProviderSelection = {
  order?: readonly ProviderId[]
  disabled?: readonly ProviderId[]
}

/**
 * One model a person chose to lead a role.
 *
 * Only the identity is stored: the rest of the candidate (capabilities, free
 * tier, note) is resolved from the catalogue on every read, so a model that is
 * removed or loses a capability is dropped instead of being used on stale facts.
 */
export type RoleModelPreference = { provider: ProviderId; modelId: string }

/** The catalogued candidate this preference names, if it still exists. */
export function catalogCandidateFor(
  role: ModelRole,
  preference: RoleModelPreference,
  selection?: ProviderSelection
): ModelCandidate | null {
  return (
    catalogForRole(role, selection).find(
      (candidate) =>
        candidate.provider === preference.provider &&
        candidate.modelId === preference.modelId
    ) ?? null
  )
}

/**
 * The candidates for one role, in routing order.
 *
 * `selection` narrows or reorders the providers for one person's turn. It can
 * only skip providers, never add one: the operator's `PARADOX_DISABLED_PROVIDERS`
 * always applies, because that is a server decision about a key the person
 * cannot see or rotate.
 */
export function catalogForRole(
  role: ModelRole,
  selection?: ProviderSelection
): ModelCandidate[] {
  const disabled = new Set<ProviderId>([
    ...disabledProviders(),
    ...(selection?.disabled ?? []),
  ])
  const order =
    selection?.order && selection.order.length > 0
      ? [...selection.order]
      : providerOrder()
  const candidates: ModelCandidate[] = []

  for (const provider of order) {
    if (disabled.has(provider)) continue
    const block = BY_PROVIDER[provider]
    // A provider id from an old saved row that no longer exists is ignored
    if (!block) continue
    candidates.push(...block[role])
  }

  const backstop = backstopModel()
  const override = roleOverride(role)

  if (override) candidates.unshift(override)
  if (backstop) {
    candidates.push({
      provider: "openrouter",
      modelId: backstop,
      capabilities: [...(overrideCapabilities(role) as ModelCapability[])],
      freeTier: false,
      source: "backstop",
      note: "explicit OpenRouter backstop",
    })
  }

  return dedupe(candidates)
}

function dedupe(candidates: ModelCandidate[]): ModelCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((entry) => {
    const key = `${entry.provider}:${entry.modelId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Puts the person's chosen model first, keeping the rest of the ladder intact.
 *
 * Hoisting only reorders: if the chosen model cannot satisfy the call (it is
 * dropped by the role's requirements), fallback still happens normally instead
 * of the request failing on a preference.
 */
export function withModelPreference(
  candidates: ModelCandidate[],
  preference?: RoleModelPreference
): ModelCandidate[] {
  if (!preference) return candidates
  const index = candidates.findIndex(
    (candidate) =>
      candidate.provider === preference.provider &&
      candidate.modelId === preference.modelId
  )
  if (index <= 0) return candidates

  const reordered = [...candidates]
  const [chosen] = reordered.splice(index, 1)
  if (!chosen) return candidates
  reordered.unshift(chosen)
  return reordered
}

/** Every model id the catalog can reach, once each. */
export function catalogModelIds(
  selection?: ProviderSelection
): { provider: ProviderId; modelId: string }[] {
  const seen = new Set<string>()
  const ids: { provider: ProviderId; modelId: string }[] = []
  for (const role of MODEL_ROLES) {
    for (const entry of catalogForRole(role, selection)) {
      const key = `${entry.provider}:${entry.modelId}`
      if (seen.has(key)) continue
      seen.add(key)
      ids.push({ provider: entry.provider, modelId: entry.modelId })
    }
  }
  return ids
}

export function missingCapabilities(
  candidate: ModelCandidate,
  requirements: ModelRequirements
): ModelCapability[] {
  return (Object.entries(requirements) as [ModelCapability, boolean][])
    .filter(([, required]) => required)
    .map(([capability]) => capability)
    .filter((capability) => !candidate.capabilities.includes(capability))
}

export function satisfies(
  candidate: ModelCandidate,
  requirements: ModelRequirements
): boolean {
  return missingCapabilities(candidate, requirements).length === 0
}

/**
 * Which role an agent kind draws from. Browser agents plan on the fast ladder,
 * which ends on stronger models; computer agents need image input; social uses
 * the creative ladder and falls back to a reasoner-quality model.
 */
export function modelRoleForAgentKind(agentKind?: string): ModelRole {
  switch (agentKind) {
    case "browser":
      return "fast"
    case "computer":
      return "vision"
    case "social":
      return "creative"
    case "code":
      return "code"
    default:
      return "general"
  }
}

/**
 * The model each agent kind names first. Kept for the dashboard and for anyone
 * reading the previous configuration; routing itself uses `catalogForRole`.
 */
export const modelForAgentKind = {
  chat: MODEL_CONFIG.general,
  browser: MODEL_CONFIG.fast,
  computer: MODEL_CONFIG.vision,
  social: MODEL_CONFIG.creative,
  default: MODEL_CONFIG.general,
} as const

/** Every model role available in the config. */
export function modelRoles(): ModelRole[] {
  return [...MODEL_ROLES]
}
