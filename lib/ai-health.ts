import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText, type LanguageModel } from "ai"

import { redact } from "./ai/fallback"
import { catalogForRole } from "./ai/models"
import { planForRole } from "./ai/model-router"
import { adapterFor, providerConfigurations } from "./ai/provider-registry"
import { quotaReport, type ProviderQuotaReport } from "./ai/quota-manager"
import type { ProviderConfiguration, ProviderId } from "./ai/types"
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
  /** "skipped" means the probe budget ran out before this model was called. */
  status?: "ok" | "failed" | "skipped"
}

/**
 * One tiny call through one provider's own adapter.
 *
 * This is the check the OpenRouter catalogue cannot do: whether each rung of the
 * fallback ladder is reachable *right now* with the credentials this deployment
 * holds. It goes straight to the adapter instead of through the router, so a
 * cooldown learned earlier does not hide the provider's real state (and the
 * probe touches no quota bookkeeping).
 */
export type ProviderProbe = {
  provider: ProviderId
  /** The model the general role would use on this provider, if any. */
  model: string | null
  status: "ok" | "failed" | "skipped"
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
  /** Per-provider reachability, when `?probe=1` asked for it. */
  providerProbes?: ProviderProbe[]
  /** Total time the probes were allowed, so a caller knows what was cut short. */
  probeBudgetMs?: number
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

// Every network call in this endpoint is bounded. It runs inside an HTTP request
// handler with a hard time limit (a proxy or a serverless host kills a long
// request after a few seconds): an unbounded fetch would end as a 502 with no
// diagnosis at all, which is worse than a partial answer.
const CATALOGUE_TIMEOUT_MS = 4_000
/** Per-probe cap. */
const PROBE_TIMEOUT_MS = 4_000
/** Whole probe phase, so `?probe=1` still fits in one request. */
const PROBE_BUDGET_MS = 8_000

async function fetchCatalogue(
  key: string
): Promise<{ models: CatalogueEntry[]; error?: string }> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
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
function budgetLeft(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

function timeoutFor(deadline: number): number {
  return Math.max(250, Math.min(PROBE_TIMEOUT_MS, budgetLeft(deadline)))
}

async function probeModel(
  key: string,
  id: string,
  deadline: number
): Promise<ModelProbe> {
  if (budgetLeft(deadline) < 250) {
    return { id, ok: false, ms: 0, status: "skipped", error: "probe budget spent" }
  }

  const started = Date.now()
  try {
    const result = await generateText({
      model: createOpenRouter({ apiKey: key }).chat(id),
      prompt: "Reply with exactly: OK",
      maxOutputTokens: 16,
      // One probe is one call: the retry layers belong to a real turn, not to a
      // diagnostic that must fit in a short function deadline.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutFor(deadline)),
      providerOptions: { openrouter: { reasoning: { effort: "none" } } },
    })
    const ms = Date.now() - started
    const text = result.text.trim()
    return text.length > 0
      ? { id, ok: true, ms, status: "ok" }
      : { id, ok: false, ms, status: "failed", error: "empty answer" }
  } catch (error) {
    return {
      id,
      ok: false,
      ms: Date.now() - started,
      status: "failed",
      error: error instanceof Error ? redact(error.message) : "request failed",
    }
  }
}

/**
 * Calls each provider once, through its own adapter, all at the same time.
 *
 * A provider with no catalogued model is reported as skipped rather than
 * failed: that is a gap in the catalogue, not an outage.
 */
/**
 * One provider, one tiny call, through that provider's own adapter.
 *
 * Exported because Settings → Integrations tests a single provider on demand;
 * the batch below reuses it so the two paths cannot drift.
 */
export async function probeProviderById(
  provider: ProviderId,
  deadline: number = Date.now() + PROBE_TIMEOUT_MS
): Promise<ProviderProbe> {
  const candidate = catalogForRole("general").find(
    (model) => model.provider === provider
  )
  if (!candidate) {
    return {
      provider,
      model: null,
      status: "skipped",
      ms: 0,
      error: "no model catalogued for this provider",
    }
  }

  if (budgetLeft(deadline) < 250) {
    return {
      provider,
      model: candidate.modelId,
      status: "skipped",
      ms: 0,
      error: "probe budget spent",
    }
  }

  const started = Date.now()
  try {
    const adapter = adapterFor(provider)
    const result = await generateText({
      model: adapter.createModel(candidate.modelId) as LanguageModel,
      prompt: "Reply with exactly: OK",
      maxOutputTokens: 8,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutFor(deadline)),
      ...(provider === "openrouter" && {
        providerOptions: { openrouter: { reasoning: { effort: "none" } } },
      }),
    })
    const ms = Date.now() - started
    return result.text.trim().length > 0
      ? { provider, model: candidate.modelId, status: "ok", ms }
      : {
          provider,
          model: candidate.modelId,
          status: "failed",
          ms,
          error: "empty answer",
        }
  } catch (error) {
    return {
      provider,
      model: candidate.modelId,
      status: "failed",
      ms: Date.now() - started,
      error: error instanceof Error ? redact(error.message) : "request failed",
    }
  }
}

/**
 * Calls each configured provider once, all at the same time.
 *
 * A provider with no catalogued model is reported as skipped rather than failed:
 * that is a gap in the catalogue, not an outage.
 */
async function probeProviders(deadline: number): Promise<ProviderProbe[]> {
  const configured = providerConfigurations().filter((entry) => entry.configured)
  return Promise.all(configured.map((entry) => probeProviderById(entry.id, deadline)))
}

// Free providers rate-limit aggressively, so probes run a few at a time instead
// of all at once: the point is to measure each model, not to stress the tier.
async function probeAll(
  key: string,
  ids: string[],
  deadline: number
): Promise<ModelProbe[]> {
  const results: ModelProbe[] = []
  const concurrency = 2
  for (let index = 0; index < ids.length; index += concurrency) {
    const batch = ids.slice(index, index + concurrency)
    results.push(
      ...(await Promise.all(batch.map((id) => probeModel(key, id, deadline))))
    )
    if (budgetLeft(deadline) < 250) {
      // Out of time: say which ids were not measured instead of dropping them
      results.push(
        ...ids.slice(index + concurrency).map((id): ModelProbe => ({
          id,
          ok: false,
          ms: 0,
          status: "skipped",
          error: "probe budget spent",
        }))
      )
      break
    }
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

  // The budget starts before the first network call, so the whole request —
  // catalogue, allowance and probes — stays inside one function timeout.
  const deadline = Date.now() + PROBE_BUDGET_MS
  const key = apiKey()

  if (!key) {
    // Still worth probing: another provider may be configured and healthy, and
    // that is exactly what someone debugging "no responde" needs to see.
    const providerProbes = options.probe ? await probeProviders(deadline) : undefined

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
      ...(providerProbes && { providerProbes, probeBudgetMs: PROBE_BUDGET_MS }),
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

  const [probes, providerProbes] = options.probe
    ? await Promise.all([probeAll(key, ids, deadline), probeProviders(deadline)])
    : [undefined, undefined]

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
    ...(probes && { probes, providerProbes, probeBudgetMs: PROBE_BUDGET_MS }),
  }
}
