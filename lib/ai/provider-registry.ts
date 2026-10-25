import {
  catalogModelIds,
  PROVIDER_LABELS,
  PROVIDER_QUOTA_UNITS,
  providerOrder,
  roleEffort,
} from "./models"
import {
  providerAvailability,
  type QuotaAvailability,
} from "./quota-manager"
import { cloudflare } from "./providers/cloudflare"
import { cerebras } from "./providers/cerebras"
import { gemini } from "./providers/gemini"
import { groq } from "./providers/groq"
import { openrouter } from "./providers/openrouter"
import type {
  ModelCandidate,
  ModelRole,
  ProviderAdapter,
  ProviderConfiguration,
  ProviderId,
  ProviderModel,
} from "./types"

/**
 * The only place provider adapters are looked up.
 *
 * Adding a provider means writing one adapter and adding it to `ADAPTERS`; no
 * agent, action or chat code changes. Everything here is server-side and reads
 * credentials from `process.env` only.
 */

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  openrouter,
  gemini,
  cerebras,
  groq,
  cloudflare,
}

/** Adapters in routing order (`PARADOX_PROVIDER_ORDER` applies). */
export function adapters(): ProviderAdapter[] {
  return providerOrder().map((id) => ADAPTERS[id])
}

export function adapterFor(id: ProviderId): ProviderAdapter {
  return ADAPTERS[id]
}

/**
 * A short, non-reversible fingerprint of the provider's credentials.
 *
 * It lets an auth failure clear itself when the operator rotates the key,
 * without the manager storing the key. It is not used as a security primitive.
 */
export function credentialFingerprint(id: ProviderId): string | undefined {
  const adapter = ADAPTERS[id]
  const values = adapter.requires
    .map((name) => process.env[name]?.trim() ?? "")
    .filter(Boolean)
  if (values.length === 0) return undefined

  // FNV-1a, 32-bit: enough to notice a different key, safe to keep in memory.
  let hash = 0x811c9dc5
  const input = `${id}:${values.join("\u0000")}`
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

export type ProviderReadiness = {
  configured: boolean
  missing: string[]
  availability: QuotaAvailability
}

/** Whether a provider has credentials, and whether it is currently cooled down. */
export function providerReadiness(id: ProviderId): ProviderReadiness {
  const adapter = ADAPTERS[id]
  const configured = adapter.isConfigured()
  return {
    configured,
    missing: adapter.missingEnv(),
    availability: configured
      ? providerAvailability(id, credentialFingerprint(id))
      : { available: false, reason: undefined, detail: "not configured" },
  }
}

/** Every provider, with booleans and env names only — never a value. */
export function providerConfigurations(): ProviderConfiguration[] {
  const models = catalogModelIds()
  return providerOrder().map((id) => {
    const adapter = ADAPTERS[id]
    return {
      id,
      label: PROVIDER_LABELS[id],
      configured: adapter.isConfigured(),
      requires: adapter.requires,
      missing: adapter.missingEnv(),
      models: models.filter((entry) => entry.provider === id).map((entry) => entry.modelId),
      quotaUnit: PROVIDER_QUOTA_UNITS[id],
      note: adapter.note,
    }
  })
}

export function configuredProviders(): ProviderId[] {
  return providerOrder().filter((id) => ADAPTERS[id].isConfigured())
}

/** Provider ids that are configured and not cooling down. */
export function availableProviders(): ProviderId[] {
  return configuredProviders().filter((id) => providerReadiness(id).availability.available)
}

export type ResolvedModel =
  | { ok: true; provider: ProviderId; modelId: string; resolved: ProviderModel }
  | {
      ok: false
      provider: ProviderId
      modelId: string
      reason: "unconfigured" | "cooldown" | "unsupported_model" | "failed"
      detail: string
      until?: number
    }

/**
 * Builds one candidate's model, or explains why it cannot be called.
 *
 * A model is never built with a fallback credential and never silently swapped
 * for another provider: the caller gets an explicit reason and picks the next
 * candidate itself.
 */
export function resolveCandidate(
  candidate: ModelCandidate,
  role: ModelRole,
  options: { serverFallbackModels?: string[] } = {}
): ResolvedModel {
  const adapter = ADAPTERS[candidate.provider]
  const missing = adapter.missingEnv()
  if (missing.length > 0) {
    return {
      ok: false,
      provider: candidate.provider,
      modelId: candidate.modelId,
      reason: "unconfigured",
      detail: `missing ${missing.join(", ")}`,
    }
  }

  const readiness = providerReadiness(candidate.provider)
  if (!readiness.availability.available) {
    const reason = readiness.availability.reason
    return {
      ok: false,
      provider: candidate.provider,
      modelId: candidate.modelId,
      reason: reason === "unsupported_model" ? "unsupported_model" : "cooldown",
      detail: readiness.availability.detail ?? reason ?? "provider unavailable",
      ...(readiness.availability.until && { until: readiness.availability.until }),
    }
  }

  try {
    const model = adapter.createModel(candidate.modelId)
    const providerOptions = adapter.callOptions?.({
      modelId: candidate.modelId,
      role,
      effort: roleEffort(role),
      serverFallbackModels: options.serverFallbackModels,
    })

    return {
      ok: true,
      provider: candidate.provider,
      modelId: candidate.modelId,
      resolved: {
        model,
        ...(providerOptions && { providerOptions }),
        ...(options.serverFallbackModels?.length && {
          serverFallbackModels: options.serverFallbackModels,
        }),
      },
    }
  } catch (error) {
    return {
      ok: false,
      provider: candidate.provider,
      modelId: candidate.modelId,
      reason: "failed",
      detail: error instanceof Error ? error.message.slice(0, 200) : "provider failed to initialise",
    }
  }
}

/**
 * Startup validation: names which providers are ready and which env vars are
 * missing, without printing a single value. The app keeps running when optional
 * providers are unset — the router simply skips them.
 */
export function aiProviderStartupReport(): {
  summary: string
  configured: ProviderId[]
  missing: Partial<Record<ProviderId, string[]>>
} {
  const configured: ProviderId[] = []
  const missing: Partial<Record<ProviderId, string[]>> = {}

  for (const adapter of adapters()) {
    if (adapter.isConfigured()) {
      configured.push(adapter.id)
    } else {
      missing[adapter.id] = adapter.missingEnv()
    }
  }

  const parts = adapters().map((adapter) =>
    adapter.isConfigured()
      ? `${adapter.id}=ready`
      : `${adapter.id}=skipped(${adapter.missingEnv().join("+")})`
  )

  return {
    summary: `AI providers: ${parts.join(", ")}`,
    configured,
    missing,
  }
}

let startupLogged = false

/** Logged once per process; called from instrumentation and the Trigger tasks. */
export function logAiProviderConfiguration(): void {
  if (startupLogged) return
  startupLogged = true

  const report = aiProviderStartupReport()
  const level = report.configured.length > 0 ? "info" : "warn"
  console[level](`[ai] ${report.summary}`)
}

/** Test seam: let a suite assert the startup report more than once. */
export function resetStartupLog(): void {
  startupLogged = false
}
