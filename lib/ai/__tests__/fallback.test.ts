import { describe, expect, it } from "vitest"

import {
  backoffDelayMs,
  classifyProviderError,
  parseDuration,
  redact,
  retryAfterFromHeaders,
} from "../fallback"

/** A provider-shaped error, the way the AI SDK raises it. */
function apiError(options: {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  message?: string
  name?: string
}) {
  const error = new Error(options.message ?? "provider error") as Error &
    Record<string, unknown>
  if (options.name) error.name = options.name
  if (options.status) error.statusCode = options.status
  if (options.body !== undefined) {
    error.responseBody =
      typeof options.body === "string" ? options.body : JSON.stringify(options.body)
  }
  if (options.headers) error.responseHeaders = options.headers
  return error
}

describe("classifyProviderError", () => {
  it("recognises OpenRouter's daily free-model cap as an exhausted quota", () => {
    const classified = classifyProviderError(
      apiError({
        status: 429,
        body: {
          error: {
            message:
              "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
          },
        },
        headers: { "x-ratelimit-limit": "50", "x-ratelimit-remaining": "0" },
      }),
      "openrouter"
    )

    expect(classified.category).toBe("quota_exhausted")
    expect(classified.dailyQuota).toBe(true)
    // A daily cap is never retried inside the same request.
    expect(classified.retryable).toBe(false)
    expect(classified.resetsAt).toBeGreaterThan(Date.now())
  })

  it("keeps an upstream per-minute 429 as a temporary rate limit", () => {
    const classified = classifyProviderError(
      apiError({
        status: 429,
        body: { error: { message: "upstream provider is rate-limited" } },
        headers: { "retry-after": "2" },
      }),
      "openrouter"
    )

    expect(classified.category).toBe("rate_limited")
    expect(classified.dailyQuota).toBe(false)
    expect(classified.retryable).toBe(true)
    expect(classified.retryAfterMs).toBe(2000)
  })

  it("separates Gemini's per-minute quota from its per-day quota", () => {
    const perMinute = classifyProviderError(
      apiError({
        status: 429,
        body: {
          error: {
            status: "RESOURCE_EXHAUSTED",
            message:
              "Quota exceeded for metric: generate_content_free_tier_requests per minute, limit: 5",
          },
        },
      }),
      "gemini"
    )
    expect(perMinute.category).toBe("rate_limited")
    expect(perMinute.retryable).toBe(true)

    const perDay = classifyProviderError(
      apiError({
        status: 429,
        body: {
          error: {
            status: "RESOURCE_EXHAUSTED",
            message:
              "Quota exceeded for metric: generate_content_free_tier_requests, requests per day",
          },
        },
      }),
      "gemini"
    )
    expect(perDay.category).toBe("quota_exhausted")
    expect(perDay.dailyQuota).toBe(true)
  })

  it("reads Groq's requests-per-day header as a daily quota", () => {
    const classified = classifyProviderError(
      apiError({
        status: 429,
        body: { error: { message: "Rate limit reached" } },
        headers: {
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": "1m2.4s",
        },
      }),
      "groq"
    )

    expect(classified.category).toBe("quota_exhausted")
    expect(classified.retryAfterMs).toBe(62_400)
  })

  it("distinguishes Workers AI's Neuron exhaustion from a capacity blip", () => {
    const exhausted = classifyProviderError(
      apiError({
        status: 429,
        body: {
          errors: [
            {
              code: 3036,
              message:
                "You have used up your daily free allocation of 10,000 neurons.",
            },
          ],
        },
      }),
      "cloudflare"
    )
    expect(exhausted.category).toBe("quota_exhausted")

    const busy = classifyProviderError(
      apiError({
        status: 429,
        body: { errors: [{ code: 3040, message: "Capacity temporarily exceeded" }] },
      }),
      "cloudflare"
    )
    expect(busy.category).toBe("rate_limited")
    expect(busy.retryable).toBe(true)
  })

  it("marks rejected credentials as an auth failure", () => {
    const classified = classifyProviderError(
      apiError({ status: 401, body: { error: { message: "Invalid API key" } } }),
      "groq"
    )
    expect(classified.category).toBe("auth")
    expect(classified.retryable).toBe(false)
  })

  it("marks a model the account cannot run as unsupported", () => {
    const classified = classifyProviderError(
      apiError({
        status: 404,
        body: { error: { message: "model not found: gpt-oss-999" } },
      }),
      "cerebras"
    )
    expect(classified.category).toBe("unsupported")
    expect(classified.retryable).toBe(false)
  })

  it("retries server errors and network failures", () => {
    expect(
      classifyProviderError(apiError({ status: 503, message: "overloaded" }), "gemini")
        .category
    ).toBe("server")
    expect(
      classifyProviderError(new TypeError("fetch failed"), "groq").category
    ).toBe("network")
    expect(
      classifyProviderError(new TypeError("fetch failed"), "groq").retryable
    ).toBe(true)
  })

  it("treats a deadline as a retryable timeout and a cancellation as final", () => {
    const deadline = classifyProviderError(
      apiError({ message: "model did not answer within 10ms", name: "ModelDeadlineError" }),
      "openrouter"
    )
    expect(deadline.category).toBe("timeout")
    expect(deadline.retryable).toBe(true)

    const cancelled = classifyProviderError(
      apiError({ message: "The operation was aborted", name: "AbortError" }),
      "openrouter"
    )
    expect(cancelled.category).toBe("aborted")
    expect(cancelled.retryable).toBe(false)
  })
})

describe("retry helpers", () => {
  it("parses Retry-After seconds, HTTP dates and Go durations", () => {
    expect(retryAfterFromHeaders({ "retry-after": "3" })).toBe(3000)
    expect(parseDuration("1m2.4s")).toBe(62_400)
    expect(parseDuration("500ms")).toBe(500)
    expect(parseDuration("2m")).toBe(120_000)
    expect(parseDuration("not a duration")).toBeNull()
  })

  it("backs off exponentially with jitter and a ceiling", () => {
    const first = backoffDelayMs(0, { baseMs: 300, maxMs: 4_000, random: () => 0.5 })
    expect(first).toBe(225)

    const later = backoffDelayMs(4, { baseMs: 300, maxMs: 4_000, random: () => 0.99 })
    expect(later).toBeLessThanOrEqual(4_000)
    expect(later).toBeGreaterThanOrEqual(2_000)
  })

  it("redacts anything that looks like a key", () => {
    expect(redact("bad key sk-abcdef123456 rejected")).not.toContain("abcdef123456")
    expect(redact("Bearer gsk_abcdefghijklmnop")).not.toContain("abcdefghijklmnop")
  })
})
