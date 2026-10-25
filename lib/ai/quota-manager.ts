import { PROVIDER_IDS, type ProviderId, type UsageInfo } from "./types"

/**
 * Lightweight quota and cooldown awareness for each provider.
 *
 * What it knows is only what a provider actually told us: a 429, a daily cap,
 * an auth failure, a latency, token counts. It never guesses how much quota is
 * left when the provider does not report it.
 *
 * Storage: an in-memory store behind a small `QuotaStore` interface. That is
 * enough for the long-lived Trigger.dev task process, which is where chat turns
 * and agents actually call models. In a serverless Next.js deployment each
 * instance has its own copy, so a cooldown learned by one instance is not
 * visible to another; swap `setQuotaStore` for a shared store (Redis, D1, the
 * Postgres usage ledger) if that matters. See `docs/ai-providers.md`.
 *
 * Provider-specific units are kept apart: OpenRouter counts requests, Workers
 * AI counts Neurons, Cerebras counts tokens. They are never added together.
 */

export type CooldownReason =
  | "rate_limited"
  | "quota_exhausted"
  | "auth"
  | "outage"
  | "unsupported_model"

export type ProviderMetrics = {
  /** Calls attempted, including ones that never reached the provider. */
  requests: number
  successes: number
  failures: number
  rateLimitErrors: number
  quotaErrors: number
  authErrors: number
  latencyMsLast: number | null
  latencyMsAverage: number | null
  inputTokens: number
  outputTokens: number
  /** Millionths of a dollar, when the provider returns a price. */
  costMicros: number
  /** Provider-specific units, e.g. `{ neurons: 4200 }` for Workers AI. */
  units: Record<string, number>
  lastFailureAt: number | null
  lastSuccessAt: number | null
  lastErrorCategory: string | null
}

export type Cooldown = {
  until: number
  reason: CooldownReason
  detail?: string
}

type ProviderState = {
  metrics: ProviderMetrics
  cooldown?: Cooldown
  /** Set when the provider rejected our credentials. */
  auth?: { fingerprint: string; failedAt: number; detail?: string }
}

type ModelState = {
  cooldown?: Cooldown
  lastFailureAt: number | null
}

export type QuotaState = {
  providers: Partial<Record<ProviderId, ProviderState>>
  models: Record<string, ModelState>
  savedAt: number
}

export type QuotaAvailability = {
  available: boolean
  reason?: CooldownReason
  until?: number
  detail?: string
}

/** The persistence seam. The default store is process memory. */
export type QuotaStore = {
  load(): QuotaState | null
  save(state: QuotaState): void
}

function emptyMetrics(): ProviderMetrics {
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    rateLimitErrors: 0,
    quotaErrors: 0,
    authErrors: 0,
    latencyMsLast: null,
    latencyMsAverage: null,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
    units: {},
    lastFailureAt: null,
    lastSuccessAt: null,
    lastErrorCategory: null,
  }
}

function emptyState(): QuotaState {
  return { providers: {}, models: {}, savedAt: 0 }
}

let memoryState: QuotaState = emptyState()

const memory: QuotaStore = {
  load: () => memoryState,
  save: (next) => {
    memoryState = next
  },
}

let store: QuotaStore = memory
let now: () => number = () => Date.now()

/** Replace the store (shared cache, database) or reset it between tests. */
export function setQuotaStore(next: QuotaStore | null): void {
  store = next ?? memory
}

/** Tests drive time explicitly; production uses `Date.now`. */
export function setQuotaClock(next: (() => number) | null): void {
  now = next ?? (() => Date.now())
}

export function resetQuotaManager(): void {
  memoryState = emptyState()
  store = memory
  setQuotaClock(null)
}

function state(): QuotaState {
  const loaded = store.load()
  return loaded ?? emptyState()
}

function persist(next: QuotaState): void {
  next.savedAt = now()
  store.save(next)
}

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

function rateLimitCooldownMs(): number {
  return envMs("PARADOX_COOLDOWN_RATE_LIMIT_MS", 30_000)
}
function quotaCooldownMs(): number {
  return envMs("PARADOX_COOLDOWN_QUOTA_MS", 60 * 60 * 1000)
}
function outageCooldownMs(): number {
  return envMs("PARADOX_COOLDOWN_OUTAGE_MS", 60_000)
}
function unsupportedCooldownMs(): number {
  return envMs("PARADOX_COOLDOWN_UNSUPPORTED_MS", 10 * 60 * 1000)
}

const MAX_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000
const MIN_COOLDOWN_MS = 1_000

function providerState(current: QuotaState, provider: ProviderId): ProviderState {
  const existing = current.providers[provider]
  if (existing) return existing
  const created: ProviderState = { metrics: emptyMetrics() }
  current.providers[provider] = created
  return created
}

function modelKey(provider: ProviderId, modelId: string): string {
  return `${provider}:${modelId}`
}

function modelState(current: QuotaState, provider: ProviderId, modelId: string): ModelState {
  const key = modelKey(provider, modelId)
  const existing = current.models[key]
  if (existing) return existing
  const created: ModelState = { lastFailureAt: null }
  current.models[key] = created
  return created
}

function activeCooldown(cooldown: Cooldown | undefined): Cooldown | null {
  return cooldown && cooldown.until > now() ? cooldown : null
}

/**
 * Whether a provider may be called. `fingerprint` is a short hash of the
 * provider's key, never the key: it lets an auth failure clear itself when the
 * operator rotates the credentials.
 */
export function providerAvailability(
  provider: ProviderId,
  fingerprint?: string
): QuotaAvailability {
  const current = state()
  const entry = current.providers[provider]
  if (!entry) return { available: true }

  if (entry.auth) {
    if (fingerprint && fingerprint !== entry.auth.fingerprint) {
      // Configuration changed since the failure: give it another chance.
      delete entry.auth
      persist(current)
    } else {
      return {
        available: false,
        reason: "auth",
        detail: entry.auth.detail ?? "credentials rejected",
      }
    }
  }

  const cooldown = activeCooldown(entry.cooldown)
  if (!cooldown) return { available: true }

  return {
    available: false,
    reason: cooldown.reason,
    until: cooldown.until,
    detail: cooldown.detail,
  }
}

/** Whether one model may be called. Provider cooldowns apply on top. */
export function modelAvailability(
  provider: ProviderId,
  modelId: string,
  fingerprint?: string
): QuotaAvailability {
  const providerStateNow = providerAvailability(provider, fingerprint)
  if (!providerStateNow.available) return providerStateNow

  const cooldown = activeCooldown(state().models[modelKey(provider, modelId)]?.cooldown)
  if (!cooldown) return { available: true }

  return {
    available: false,
    reason: cooldown.reason,
    until: cooldown.until,
    detail: cooldown.detail,
  }
}

export function noteRequest(provider: ProviderId): void {
  const current = state()
  providerState(current, provider).metrics.requests += 1
  persist(current)
}

export function noteSuccess(
  provider: ProviderId,
  modelId: string,
  info: { latencyMs?: number; usage?: UsageInfo; units?: Record<string, number> } = {}
): void {
  const current = state()
  const entry = providerState(current, provider)
  const metrics = entry.metrics

  metrics.successes += 1
  metrics.lastSuccessAt = now()

  if (info.latencyMs != null) {
    metrics.latencyMsLast = info.latencyMs
    metrics.latencyMsAverage =
      metrics.latencyMsAverage == null
        ? info.latencyMs
        : Math.round(metrics.latencyMsAverage * 0.7 + info.latencyMs * 0.3)
  }

  if (info.usage) {
    metrics.inputTokens += info.usage.inputTokens ?? 0
    metrics.outputTokens += info.usage.outputTokens ?? 0
    metrics.costMicros += info.usage.costMicros ?? 0
  }

  for (const [unit, amount] of Object.entries(info.units ?? {})) {
    if (!Number.isFinite(amount)) continue
    metrics.units[unit] = (metrics.units[unit] ?? 0) + amount
  }

  // A successful call proves a rate-limit or outage cooldown is over. It says
  // nothing about authentication (blocked until the key changes) and nothing
  // about an exhausted daily allowance (a paid backstop answering does not put
  // the free models back in rotation).
  if (
    entry.cooldown &&
    (entry.cooldown.reason === "rate_limited" || entry.cooldown.reason === "outage")
  ) {
    delete entry.cooldown
  }
  delete current.models[modelKey(provider, modelId)]?.cooldown

  persist(current)
}

export function noteFailure(
  provider: ProviderId,
  modelId: string,
  info: { category: string; latencyMs?: number }
): void {
  const current = state()
  const entry = providerState(current, provider)
  entry.metrics.failures += 1
  entry.metrics.lastFailureAt = now()
  entry.metrics.lastErrorCategory = info.category
  if (info.latencyMs != null) entry.metrics.latencyMsLast = info.latencyMs

  modelState(current, provider, modelId).lastFailureAt = now()
  persist(current)
}

/**
 * A 429. `daily` separates "this key is out for the day" from "too many
 * requests right now", because they need very different cooldowns.
 */
export function noteRateLimit(
  provider: ProviderId,
  options: {
    modelId?: string
    daily?: boolean
    retryAfterMs?: number | null
    detail?: string
  } = {}
): void {
  const current = state()
  const entry = providerState(current, provider)
  entry.metrics.rateLimitErrors += 1
  entry.metrics.lastFailureAt = now()
  entry.metrics.lastErrorCategory = options.daily ? "quota_exhausted" : "rate_limited"

  const until = options.retryAfterMs != null
    ? now() + clampCooldown(options.retryAfterMs)
    : now() + (options.daily ? quotaCooldownMs() : rateLimitCooldownMs())

  if (options.daily) entry.metrics.quotaErrors += 1

  const cooldown: Cooldown = {
    until,
    reason: options.daily ? "quota_exhausted" : "rate_limited",
    detail: options.detail,
  }

  // A per-minute 429 is usually one model's limit, not the whole account's: it
  // cools down that model only, so the provider's other models (and other
  // providers) stay in rotation. Only a daily cap, or a 429 that names no
  // model, takes the provider out as a whole.
  if (options.modelId && !options.daily) {
    modelState(current, provider, options.modelId).cooldown = cooldown
  } else {
    entry.cooldown = cooldown
  }

  persist(current)
}

/** The provider's free allowance for the period is gone. */
export function noteQuotaExhausted(
  provider: ProviderId,
  options: {
    modelId?: string
    resetsAt?: Date | number | null
    retryAfterMs?: number | null
    detail?: string
    /** Provider-specific unit the signal was in, e.g. `neurons`. */
    unit?: string
    /** How much of that unit the provider said was used, when it said. */
    used?: number
  } = {}
): void {
  const current = state()
  const entry = providerState(current, provider)
  entry.metrics.quotaErrors += 1
  entry.metrics.rateLimitErrors += 1
  entry.metrics.lastFailureAt = now()
  entry.metrics.lastErrorCategory = "quota_exhausted"

  const resetMs =
    options.resetsAt instanceof Date
      ? options.resetsAt.getTime()
      : typeof options.resetsAt === "number"
        ? options.resetsAt
        : null

  const requested = resetMs ?? (options.retryAfterMs != null ? now() + options.retryAfterMs : null)
  const fallback = now() + quotaCooldownMs()
  const until = Math.max(requested ?? fallback, now() + MIN_COOLDOWN_MS)

  entry.cooldown = { until, reason: "quota_exhausted", detail: options.detail }

  if (options.unit && options.used != null && Number.isFinite(options.used)) {
    entry.metrics.units[options.unit] = Math.max(
      entry.metrics.units[options.unit] ?? 0,
      options.used
    )
  }

  persist(current)
}

export function noteAuthFailure(
  provider: ProviderId,
  fingerprint: string,
  detail?: string
): void {
  const current = state()
  const entry = providerState(current, provider)
  entry.auth = { fingerprint, failedAt: now(), detail }
  entry.metrics.authErrors += 1
  entry.metrics.lastFailureAt = now()
  entry.metrics.lastErrorCategory = "auth"
  persist(current)
}

/**
 * One model is failing (overloaded upstream, 5xx), not necessarily the whole
 * provider. Gemini, for example, answers "this model is currently experiencing
 * high demand" for a single model while its siblings are healthy, so only that
 * model sits out for the outage cooldown.
 */
export function noteModelOutage(
  provider: ProviderId,
  modelId: string,
  detail?: string
): void {
  const current = state()
  modelState(current, provider, modelId).cooldown = {
    until: now() + outageCooldownMs(),
    reason: "outage",
    detail,
  }
  providerState(current, provider).metrics.lastErrorCategory = "server"
  persist(current)
}

export function noteProviderOutage(provider: ProviderId, detail?: string): void {
  const current = state()
  const entry = providerState(current, provider)
  entry.cooldown = {
    until: now() + outageCooldownMs(),
    reason: "outage",
    detail,
  }
  entry.metrics.lastFailureAt = now()
  entry.metrics.lastErrorCategory = "server"
  persist(current)
}

/**
 * A model the provider says it cannot run here (unknown id, no access). The
 * provider stays usable; only that model sits out for a while.
 */
export function noteUnsupportedModel(
  provider: ProviderId,
  modelId: string,
  detail?: string
): void {
  const current = state()
  modelState(current, provider, modelId).cooldown = {
    until: now() + unsupportedCooldownMs(),
    reason: "unsupported_model",
    detail,
  }
  providerState(current, provider).metrics.lastErrorCategory = "unsupported"
  persist(current)
}

export type ProviderQuotaReport = {
  provider: ProviderId
  available: boolean
  reason?: CooldownReason
  cooldownUntil?: string
  detail?: string
  /** Whether the provider reports remaining quota at all. */
  remainingQuotaKnown: false
} & ProviderMetrics

/** Everything the quota manager knows, for health pages and logs. */
export function quotaReport(): ProviderQuotaReport[] {
  const current = state()
  return PROVIDER_IDS.map((provider) => {
    const entry = current.providers[provider]
    const availability = providerAvailability(provider)
    return {
      provider,
      available: availability.available,
      ...(availability.reason && { reason: availability.reason }),
      ...(availability.until && {
        cooldownUntil: new Date(availability.until).toISOString(),
      }),
      ...(availability.detail && { detail: availability.detail }),
      // Providers do not expose remaining free quota in a uniform way, so this
      // is always false: no number here is invented.
      remainingQuotaKnown: false,
      ...(entry?.metrics ?? emptyMetrics()),
    }
  })
}

function clampCooldown(ms: number): number {
  return Math.min(Math.max(ms, MIN_COOLDOWN_MS), MAX_RATE_LIMIT_COOLDOWN_MS)
}
