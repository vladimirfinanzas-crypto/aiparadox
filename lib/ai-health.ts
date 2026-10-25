import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText } from "ai"

import { planForRole } from "./ai/model-router"
import { providerConfigurations } from "./ai/provider-registry"
import { quotaReport, type ProviderQuotaReport } from "./ai/quota-manager"
import type { ProviderConfiguration } from "./ai/types"
import { MODEL_CONFIG, MODEL_LADDERS, type ModelRole } from "./model"
import { fetchFreeQuota, type FreeQuota } from "./openrouter-quota"

/**
 * The AI runtime's health, as the server can see it.
 *
 * The checks are deliberately split in two:
 *   - `catalogue` costs one request and no tokens: it only asks OpenRouter
 *     whether every configured id exists and still supports tool calls.
 *   - `probes` cost one tiny completion per model and measure how long it takes
 *     to answer. They are what catches a model that exists but is rate-limited,
 *     hung or gated, which is exactly how the first model list failed.
 *
 * Nothing secret is returned: only ids, booleans, timings and error messages.
 */

export type ModelProbe = {
  id: string
  ok: boolean
  ms: number
  error?: string
}

export type RoleHealth = {
  role: ModelRole
  primary: string
  ladder: string[]
}

export type RolePlanHealth = {
  role: ModelRole
  required: string[]
  /** Eligible models, in routing order across providers. */
  candidates: { provider: string; model: string; freeTier: boolean }[]
  /** Models the role cannot use, with the capability they lack. */
  unsupported: { provider: string; model: string; missing: string[] }[]
}

export type AiHealth = {
  checkedAt: string
  keyConfigured: boolean
  /** Which providers have credentials, by name only. */
  providers: ProviderConfiguration[]
  /** The cross-provider plan for every role. */
  routing: RolePlanHealth[]
  /** Cooldowns, limits and metrics the quota manager has seen. */
  quotas: ProviderQuotaReport[]
  catalogueSize: number | null
  catalogueError?: string
  /** Configured ids that OpenRouter does not list at all. */
  missing: string[]
  /** Configured ids that exist but cannot take tool calls. */
  withoutTools: string[]
  roles: RoleHealth[]
  probes?: ModelProbe[]
  /** Today's free-model allowance for the key, when OpenRouter reports it. */
  quota?: FreeQuota | null
}

type CatalogueEntry = {
  id: string
  context_length?: number
  supported_parameters?: string[]
}

function apiKey() {
  const key = process.env.OPENROUTER_API_KEY
  return key && key.trim().length > 0 ? key : null
}

/** The routing plan per role, computed without calling any provider. */
export function rolePlans(): RolePlanHealth[] {
  return (Object.keys(MODEL_LADDERS) as ModelRole[]).map((role) => {
    const plan = planForRole(role)
    return {
      role,
      required: Object.entries(plan.required)
        .filter(([, needed]) => needed)
        .map(([capability]) => capability),
      candidates: plan.candidates.map((entry) => ({
        provider: entry.provider,
        model: entry.modelId,
        freeTier: entry.freeTier,
      })),
      unsupported: plan.unsupported.map((entry) => ({
        provider: entry.candidate.provider,
        model: entry.candidate.modelId,
        missing: [...entry.missing],
      })),
    }
  })
}

/** Every model id the ladders can reach, once each, in ladder order. */
export function configuredModelIds(): string[] {
  const ids = new Set<string>()
  for (const ladder of Object.values(MODEL_LADDERS)) {
    for (const id of ladder) ids.add(id)
  }
  for (const id of Object.values(MODEL_CONFIG)) ids.add(id)
  const backstop = process.env.OPENROUTER_BACKSTOP_MODEL?.trim()
  if (backstop) ids.add(backstop)
  return [...ids]
}

async function fetchCatalogue(
  key: string
): Promise<{ models: CatalogueEntry[]; error?: string }> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    })
    if (!response.ok) {
      return { models: [], error: `OpenRouter /models answered ${response.status}` }
    }
    const body = (await response.json()) as { data?: CatalogueEntry[] }
    return { models: body.data ?? [] }
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : "OpenRouter is unreachable",
    }
  }
}

/**
 * One minimal completion on one model, so the timing is the model's own and not
 * a ladder's. `reasoning` is off: a reasoning model would spend its short token
 * budget thinking and return nothing, which says nothing about its health.
 */
async function probeModel(key: string, id: string): Promise<ModelProbe> {
  const started = Date.now()
  try {
    const result = await generateText({
      model: createOpenRouter({ apiKey: key }).chat(id),
      prompt: "Reply with exactly: OK",
      maxOutputTokens: 16,
      abortSignal: AbortSignal.timeout(20_000),
      providerOptions: { openrouter: { reasoning: { effort: "none" } } },
    })
    const ms = Date.now() - started
    const text = result.text.trim()
    return text.length > 0
      ? { id, ok: true, ms }
      : { id, ok: false, ms, error: "empty answer" }
  } catch (error) {
    return {
      id,
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message.slice(0, 300) : "request failed",
    }
  }
}

// Free providers rate-limit aggressively, so probes run a few at a time instead
// of all at once: the point is to measure each model, not to stress the tier.
async function probeAll(key: string, ids: string[]): Promise<ModelProbe[]> {
  const results: ModelProbe[] = []
  const concurrency = 2
  for (let index = 0; index < ids.length; index += concurrency) {
    const batch = ids.slice(index, index + concurrency)
    results.push(...(await Promise.all(batch.map((id) => probeModel(key, id)))))
  }
  return results
}

export async function checkAiHealth(
  options: { probe?: boolean } = {}
): Promise<AiHealth> {
  const backstop = process.env.OPENROUTER_BACKSTOP_MODEL?.trim()
  const roles: RoleHealth[] = (
    Object.keys(MODEL_LADDERS) as ModelRole[]
  ).map((role) => ({
    role,
    primary: MODEL_CONFIG[role],
    ladder: backstop
      ? [...MODEL_LADDERS[role], backstop].filter(
          (id, index, all) => all.indexOf(id) === index
        )
      : MODEL_LADDERS[role],
  }))

  const providers = providerConfigurations()
  const routing = rolePlans()
  const quotas = quotaReport()

  const key = apiKey()
  if (!key) {
    return {
      checkedAt: new Date().toISOString(),
      keyConfigured: false,
      providers,
      routing,
      quotas,
      catalogueSize: null,
      catalogueError: "OPENROUTER_API_KEY is not set on the server",
      missing: configuredModelIds(),
      withoutTools: [],
      roles,
    }
  }

  const ids = configuredModelIds()
  const [catalogue, quota] = await Promise.all([
    fetchCatalogue(key),
    fetchFreeQuota(key),
  ])
  const byId = new Map(
    catalogue.models.map((model) => [model.id, model] as const)
  )

  const missing = ids.filter((id) => !byId.has(id))
  // A model that exists but cannot call tools cannot run an agent turn.
  const withoutTools = ids.filter((id) => {
    const entry = byId.get(id)
    if (!entry?.supported_parameters) return false
    return !entry.supported_parameters.includes("tools")
  })

  return {
    checkedAt: new Date().toISOString(),
    keyConfigured: true,
    providers,
    routing,
    quotas,
    catalogueSize: catalogue.models.length,
    ...(catalogue.error && { catalogueError: catalogue.error }),
    missing,
    withoutTools,
    roles,
    quota,
    ...(options.probe && { probes: await probeAll(key, ids) }),
  }
}
