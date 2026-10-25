import type { ProviderId } from "./types"

/**
 * Turns a provider failure into a decision the router can act on:
 * skip this provider for the day, wait and retry, move to the next model, or
 * give up. It also owns the bounded backoff used for transient failures.
 *
 * The classification is provider-aware because a 429 means different things
 * everywhere: OpenRouter names its daily free-model cap in the body, Groq
 * reports requests-per-day in its headers, Workers AI uses error code 3036 for
 * its daily Neuron allocation and 3040 for plain capacity, and Gemini uses
 * RESOURCE_EXHAUSTED for both a per-minute and a per-day limit.
 */

export type ErrorCategory =
  | "quota_exhausted"
  | "rate_limited"
  | "auth"
  | "timeout"
  | "unsupported"
  | "server"
  | "network"
  | "aborted"
  | "unknown"

export type ClassifiedError = {
  category: ErrorCategory
  /** Worth calling the same model again after a short delay. */
  retryable: boolean
  /** The provider's own Retry-After, when it sent one. */
  retryAfterMs: number | null
  /** A 429 that is a daily allowance, not a momentary burst. */
  dailyQuota: boolean
  /** When a daily allowance is documented to reset, in epoch ms. */
  resetsAt: number | null
  status: number | null
  /** Safe, truncated message: never a prompt, never a key. */
  message: string
}

/** The model did not produce its first output within the deadline. */
export class ModelDeadlineError extends Error {
  constructor(
    readonly modelId: string,
    readonly deadlineMs: number
  ) {
    super(`${modelId} did not answer within ${deadlineMs}ms`)
    this.name = "ModelDeadlineError"
  }
}

/** Categories a skipped candidate can report, including configuration. */
export type FailureCategory = ErrorCategory | "unconfigured" | "cooldown"

export type FailedAttempt = {
  provider: ProviderId
  modelId: string
  category: FailureCategory
  message: string
}

/**
 * Every provider that could run this call failed or was unavailable. The
 * message is what the person sees, so it says plainly that this is temporary.
 */
export class AllProvidersFailedError extends Error {
  constructor(
    readonly role: string,
    readonly attempts: FailedAttempt[],
    readonly retryAt: Date | null = null,
    readonly reason: "all_failed" | "no_eligible_model" | "none_configured" = "all_failed"
  ) {
    const detail = attempts
      .slice(0, 6)
      .map((attempt) => `${attempt.provider}/${attempt.modelId}: ${attempt.category}`)
      .join("; ")

    const when = retryAt
      ? ` Try again after ${retryAt.toISOString()}.`
      : " Try again in a moment."

    super(
      `No AI provider could answer the ${role} request right now.${when}` +
        (detail ? ` (${detail})` : "")
    )
    this.name = "AllProvidersFailedError"
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms))
  })
}

/**
 * Exponential backoff with jitter. `attempt` is zero-based, so the first retry
 * waits about `baseMs`. Jitter is "equal jitter": half fixed, half random, which
 * stops parallel chat turns from retrying in lockstep.
 */
export function backoffDelayMs(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {}
): number {
  const baseMs = options.baseMs ?? 300
  const maxMs = options.maxMs ?? 4_000
  const random = options.random ?? Math.random
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt))
  const half = exponential / 2
  return Math.round(half + random() * half)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

/** Depth-limited walk over an error and its wrappers (cause, lastError, ...). */
function errorChain(error: unknown, depth = 0): Record<string, unknown>[] {
  if (!error || typeof error !== "object" || depth > 4) return []
  const record = error as Record<string, unknown>
  const chain: Record<string, unknown>[] = [record]

  for (const key of ["cause", "lastError", "error", "data", "response"]) {
    const next = record[key]
    if (next && typeof next === "object" && !Array.isArray(next)) {
      chain.push(...errorChain(next, depth + 1))
    }
  }
  if (Array.isArray(record.errors)) {
    for (const entry of record.errors.slice(0, 3)) chain.push(...errorChain(entry, depth + 1))
  }
  return chain
}

function headersOf(error: unknown): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const entry of errorChain(error)) {
    const candidate = entry.responseHeaders ?? entry.headers
    const record = asRecord(candidate)
    if (!record) continue
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string" && !(key.toLowerCase() in headers)) {
        headers[key.toLowerCase()] = value
      }
    }
  }
  return headers
}

function statusOf(error: unknown): number | null {
  for (const entry of errorChain(error)) {
    for (const key of ["statusCode", "status", "code"]) {
      const value = entry[key]
      if (typeof value === "number" && value >= 100 && value <= 599) return value
      if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value)
    }
    const response = asRecord(entry.response)
    if (response) {
      const status = response.status
      if (typeof status === "number") return status
    }
  }
  return null
}

/** Every message-like string an error carries, concatenated for matching. */
function textOf(error: unknown): string {
  const parts: string[] = []
  const push = (value: unknown) => {
    if (typeof value === "string") parts.push(value)
    else if (value != null) {
      try {
        parts.push(JSON.stringify(value))
      } catch {
        // Ignore values that cannot be serialized.
      }
    }
  }

  for (const entry of errorChain(error)) {
    push(entry.message)
    push(entry.responseBody)
    push(entry.data)
    push(entry.code)
    push(entry.type)
    push(entry.name)
  }
  if (error instanceof Error) parts.push(error.message)
  return parts.join(" ").toLowerCase()
}

function nameOf(error: unknown): string {
  if (error instanceof Error) return error.name
  const record = asRecord(error)
  return typeof record?.name === "string" ? record.name : ""
}

/** `retry-after: 30` or an HTTP date; `x-ratelimit-reset-requests: 1m2.4s`. */
export function retryAfterFromHeaders(headers: Record<string, string>): number | null {
  const direct = headers["retry-after"]
  if (direct) {
    const seconds = Number(direct)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const date = Date.parse(direct)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }

  for (const key of [
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "anthropic-ratelimit-requests-reset",
  ]) {
    const value = headers[key]
    if (!value) continue
    const parsed = parseDuration(value)
    if (parsed != null) return parsed
  }

  return null
}

/** Parses Go-style durations ("1m2.4s", "500ms"), as Groq and Gemini send. */
export function parseDuration(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  // A bare number is milliseconds when it is large, seconds when it is small.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed)
    return numeric > 1_000 ? numeric : numeric * 1000
  }

  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g
  let total = 0
  let matched = false
  let match: RegExpExecArray | null
  while ((match = pattern.exec(trimmed)) !== null) {
    matched = true
    const amount = Number(match[1])
    const unit = match[2]
    total +=
      unit === "ms"
        ? amount
        : unit === "s"
          ? amount * 1000
          : unit === "m"
            ? amount * 60_000
            : unit === "h"
              ? amount * 3_600_000
              : amount * 86_400_000
  }
  return matched ? Math.round(total) : null
}

function mentionsDailyLimit(text: string): boolean {
  return [
    "per day",
    "per-day",
    "per_day",
    "daily",
    "free-models-per-day",
    "quota exceeded",
    "insufficient_quota",
    "allowance",
    "neurons",
    "billing",
  ].some((needle) => text.includes(needle))
}

function isDailyQuotaSignal(provider: ProviderId, text: string, headers: Record<string, string>, status: number | null): boolean {
  // OpenRouter is explicit: this is today's free-model cap.
  if (text.includes("free-models-per-day")) return true

  if (provider === "cloudflare") {
    // 3036 = daily free Neuron allocation used up; 3040 = capacity, transient.
    return text.includes("3036") || text.includes("daily free allocation")
  }

  if (provider === "groq" && status === 429) {
    const remaining = headers["x-ratelimit-remaining-requests"]
    if (remaining === "0") return true
  }

  if (provider === "gemini") {
    // RESOURCE_EXHAUSTED covers both the per-minute and the per-day quota, so
    // only explicit daily wording counts; a per-minute 429 stays temporary.
    return ["perday", "per day", "per_day", "daily limit", "requests per day"].some(
      (needle) => text.includes(needle)
    )
  }

  if (status === 429 || text.includes("insufficient_quota")) {
    return mentionsDailyLimit(text)
  }

  return false
}

function isAuthSignal(text: string, status: number | null): boolean {
  if (status === 401) return true
  return [
    "invalid api key",
    "invalid_api_key",
    "api key not valid",
    "api_key_invalid",
    "unauthorized",
    "authentication",
    "permission denied",
    "invalid token",
  ].some((needle) => text.includes(needle))
}

function isUnsupportedSignal(text: string, status: number | null): boolean {
  if (text.includes("5016") || text.includes("5035")) return true // Workers AI model access
  if (text.includes("unsupportedfunctionality")) return true
  const modelProblem = [
    "model not found",
    "model_not_found",
    "no such model",
    "does not exist",
    "not supported",
    "unsupported model",
    "invalid model",
    "no endpoints found",
    "model is not available",
  ].some((needle) => text.includes(needle))

  if (modelProblem) return true
  return (status === 404 || status === 422) && text.includes("model")
}

function isNetworkSignal(text: string, name: string): boolean {
  if (name === "TypeError" && text.includes("fetch failed")) return true
  return ["econnreset", "enotfound", "etimedout", "socket hang up", "network error"].some(
    (needle) => text.includes(needle)
  )
}

function clampRetryAfter(ms: number | null): number | null {
  if (ms == null || !Number.isFinite(ms)) return null
  return Math.min(Math.max(ms, 0), 60 * 60 * 1000)
}

/** Never log a credential, even if a provider echoes one in an error. */
export function redact(message: string): string {
  return message
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]")
    .replace(/\b(sk|gsk|key|csk|or)-[A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._-]{8,}/gi, "$1[redacted]")
    .slice(0, 300)
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return redact(error.message)
  return redact(String(error))
}

/**
 * Classifies one provider failure. `provider` is needed because the same HTTP
 * status has different meanings at different APIs.
 */
function nextUtcMidnight(): number {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
}

/**
 * When a provider's daily allowance is documented to reset. Only used when the
 * provider did not send a reset time of its own.
 */
function documentedDailyReset(
  provider: ProviderId,
  daily: boolean,
  retryAfterMs: number | null
): number | null {
  if (!daily) return null
  if (retryAfterMs != null) return Date.now() + retryAfterMs

  switch (provider) {
    case "openrouter":
    case "cloudflare":
      // Free-model requests and Neurons both reset at 00:00 UTC.
      return nextUtcMidnight()
    case "gemini":
      // Gemini's requests-per-day resets at midnight Pacific time. In October
      // that is UTC-7; an extra hour of cooldown is harmless, a premature retry
      // is not, so the offset is deliberately conservative.
      return nextUtcMidnight() + 7 * 60 * 60 * 1000
    default:
      return null
  }
}

export function classifyProviderError(
  error: unknown,
  provider: ProviderId
): ClassifiedError {
  const text = textOf(error)
  const headers = headersOf(error)
  const status = statusOf(error)
  const name = nameOf(error)
  const retryAfterMs = clampRetryAfter(retryAfterFromHeaders(headers))
  const message = messageOf(error)

  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    text.includes("aborterror") ||
    text.includes("the operation was aborted")
  ) {
    // A caller's own cancellation is not retried. `AbortSignal.timeout` and
    // provider timeouts are, once, by the next rung of the ladder.
    const callerCancelled = name === "AbortError" && !retryAfterMs
    return {
      category: callerCancelled ? "aborted" : "timeout",
      retryable: !callerCancelled,
      retryAfterMs: null,
      dailyQuota: false,
      resetsAt: null,
      status,
      message,
    }
  }

  if (name === "ModelDeadlineError" || text.includes("did not answer within")) {
    return {
      category: "timeout",
      retryable: true,
      retryAfterMs: null,
      dailyQuota: false,
      resetsAt: null,
      status,
      message,
    }
  }

  if (isUnsupportedSignal(text, status)) {
    return {
      category: "unsupported",
      retryable: false,
      retryAfterMs,
      dailyQuota: false,
      resetsAt: null,
      status,
      message,
    }
  }

  if (isAuthSignal(text, status) && !text.includes("quota")) {
    return {
      category: "auth",
      retryable: false,
      retryAfterMs: null,
      dailyQuota: false,
      resetsAt: null,
      status,
      message,
    }
  }

  if (status === 429 || text.includes("too many requests") || text.includes("rate limit")) {
    const daily = isDailyQuotaSignal(provider, text, headers, status)
    return {
      category: daily ? "quota_exhausted" : "rate_limited",
      // A daily cap is not retried inside this request; the next provider is.
      retryable: !daily,
      retryAfterMs,
      dailyQuota: daily,
      resetsAt: documentedDailyReset(provider, daily, retryAfterMs),
      status,
      message,
    }
  }

  if (status != null && status >= 500) {
    return {
      category: "server",
      retryable: true,
      retryAfterMs,
      dailyQuota: false,
      resetsAt: null,
      status,
      message,
    }
  }

  if (isNetworkSignal(text, name)) {
    return {
      category: "network",
      retryable: true,
      retryAfterMs,
      dailyQuota: false,
      resetsAt: null,
      status,
      message,
    }
  }

  if (status === 402 || text.includes("insufficient_quota") || text.includes("credit")) {
    return {
      category: "quota_exhausted",
      retryable: false,
      retryAfterMs,
      dailyQuota: true,
      resetsAt: documentedDailyReset(provider, true, retryAfterMs),
      status,
      message,
    }
  }

  if (status === 400 || status === 403) {
    // A 400/403 that is not auth is usually a request the model cannot serve.
    return {
      category: "unsupported",
      retryable: false,
      retryAfterMs,
      dailyQuota: false,
      resetsAt: null,
      status,
      message,
    }
  }

  return {
    category: "unknown",
    retryable: false,
    retryAfterMs,
    dailyQuota: false,
    resetsAt: null,
    status,
    message,
  }
}
