/**
 * OpenRouter's free tier is capped per day, per key: 50 free-model requests, or
 * 1000 once the account holds 10 credits. A single agent turn spends several of
 * them (one per tool step), so the cap is reached quickly, and every further
 * call answers 429 `free-models-per-day` until midnight UTC.
 *
 * This module knows how to read that specific error and the key's allowance. The
 * cooldown it produces is stored in `lib/ai/quota-manager.ts`, so OpenRouter and
 * the other providers are tracked in one place and a spent allowance is not
 * rediscovered by every request.
 */

import {
  credentialFingerprint,
} from "./ai/provider-registry"
import { noteQuotaExhausted, providerAvailability } from "./ai/quota-manager"

export type FreeQuota = {
  /** Requests used today. */
  used: number
  /** Requests allowed today, or null when OpenRouter does not say. */
  limit: number | null
  /** Requests left today, or null when unknown. */
  remaining: number | null
  /** When the allowance resets (start of the next UTC day). */
  resetsAt: Date | null
}

/** The key has no free-model requests left today. */
export class ModelQuotaError extends Error {
  constructor(readonly quota: FreeQuota) {
    const reset = quota.resetsAt
      ? ` It resets at ${quota.resetsAt.toISOString()}.`
      : " It resets at midnight UTC."
    super(
      `The OpenRouter free-model allowance for today is used up${quota.limit ? ` (${quota.used}/${quota.limit} requests)` : ""}.${reset} Paradox will use another configured provider; add 10 credits to the OpenRouter account to raise the limit to 1000 requests a day.`
    )
    this.name = "ModelQuotaError"
  }
}

/** True for a model id billed on the free tier. */
export function isFreeModel(id: string) {
  return id.endsWith(":free")
}

function nextUtcMidnight() {
  const now = new Date()
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  )
}

/** When OpenRouter's free models start working again, or null while they do. */
export function quotaBlockedUntil(): Date | null {
  const availability = providerAvailability(
    "openrouter",
    credentialFingerprint("openrouter")
  )
  if (availability.available || !availability.until) return null
  if (availability.reason !== "quota_exhausted") return null
  return new Date(availability.until)
}

/** Remembers that the key is out of free requests until the reset. */
export function markQuotaExhausted(quota: FreeQuota): FreeQuota {
  const resetsAt = quota.resetsAt ?? nextUtcMidnight()
  noteQuotaExhausted("openrouter", {
    resetsAt,
    detail: "free-models-per-day",
  })
  return { ...quota, resetsAt }
}

type ApiErrorLike = {
  statusCode?: number
  responseBody?: string
  responseHeaders?: Record<string, string>
  data?: unknown
}

/**
 * Reads a failed request and returns the daily free-model quota it ran out of,
 * or null when the failure is something else (a busy provider, a missing model,
 * a deadline). A per-minute 429 from an upstream provider is not a daily cap.
 */
export function freeQuotaExhausted(error: unknown): FreeQuota | null {
  if (!error || typeof error !== "object") return null

  const candidate = error as ApiErrorLike
  if (candidate.statusCode !== 429) return null

  const body =
    candidate.responseBody ??
    (typeof candidate.data === "string" ? candidate.data : JSON.stringify(candidate.data ?? ""))

  if (!body.includes("free-models-per-day")) return null

  const headers = candidate.responseHeaders ?? {}
  const limit = Number(headers["x-ratelimit-limit"] ?? headers["X-RateLimit-Limit"])
  const remaining = Number(
    headers["x-ratelimit-remaining"] ?? headers["X-RateLimit-Remaining"]
  )
  const reset = Number(headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"])

  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : null
  const safeRemaining = Number.isFinite(remaining) ? remaining : null

  return {
    used: safeLimit != null && safeRemaining != null ? safeLimit - safeRemaining : 0,
    limit: safeLimit,
    remaining: safeRemaining,
    resetsAt: Number.isFinite(reset) && reset > 0 ? new Date(reset) : null,
  }
}

/**
 * The key's free-model allowance, straight from OpenRouter. Used by the
 * dashboard so "the agent is slow" has a visible cause: the day's allowance.
 */
export async function fetchFreeQuota(apiKey: string): Promise<FreeQuota | null> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    })
    if (!response.ok) return null

    const body = (await response.json()) as {
      data?: {
        free_model_daily_requests?: {
          used?: number
          limit?: number
          remaining?: number
        }
      }
    }

    const daily = body.data?.free_model_daily_requests
    if (!daily) return null

    return {
      used: daily.used ?? 0,
      limit: daily.limit ?? null,
      remaining: daily.remaining ?? null,
      resetsAt: quotaBlockedUntil() ?? null,
    }
  } catch {
    return null
  }
}
