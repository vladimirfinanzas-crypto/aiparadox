import { describe, expect, it } from "vitest"

import { AllProvidersFailedError, classifyProviderError } from "../fallback"
import { createRoutedModel, planForRole, type RouterAvailability, type RouterDeps } from "../model-router"
import type {
  AiCallOptions,
  AiGenerateResult,
  AiLanguageModel,
  AiStreamPart,
  AiStreamResult,
  ModelCandidate,
  ProviderId,
} from "../types"

// ---------------------------------------------------------------------------
// Fakes: no test in this file touches a provider or spends a real quota.
// ---------------------------------------------------------------------------

const TEXT = ["streaming", "tools", "structuredOutput"] as const

function candidate(
  provider: ProviderId,
  modelId: string,
  capabilities: readonly string[] = TEXT
): ModelCandidate {
  return {
    provider,
    modelId,
    capabilities: [...capabilities] as ModelCandidate["capabilities"],
    freeTier: true,
  }
}

function apiError(options: {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  message?: string
}) {
  const error = new Error(options.message ?? "provider error") as Error &
    Record<string, unknown>
  if (options.status) error.statusCode = options.status
  if (options.body !== undefined) error.responseBody = JSON.stringify(options.body)
  if (options.headers) error.responseHeaders = options.headers
  return error
}

const quotaError = () =>
  apiError({
    status: 429,
    body: {
      error: {
        message: "Rate limit exceeded: free-models-per-day.",
      },
    },
  })

function textResult(text: string, usage?: Record<string, number>): AiGenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop" },
    ...(usage && { usage }),
  }
}

function streamResult(parts: AiStreamPart[]): AiStreamResult {
  return {
    stream: new ReadableStream<AiStreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part)
        controller.close()
      },
    }),
  }
}

/** A stream that emits one chunk and then stays open until cancelled. */
function hangingStream(onCancel: () => void): AiStreamResult {
  return {
    stream: new ReadableStream<AiStreamPart>({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: "parcial" })
      },
      cancel() {
        onCancel()
      },
    }),
  }
}

type Fake = {
  generate?: (options: AiCallOptions) => Promise<AiGenerateResult> | AiGenerateResult
  stream?: (options: AiCallOptions) => Promise<AiStreamResult> | AiStreamResult
}

function fakeModel(modelId: string, fake: Fake): AiLanguageModel {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId,
    supportedUrls: {},
    async doGenerate() {
      if (!fake.generate) throw new Error(`${modelId} has no generate fake`)
      return fake.generate({})
    },
    async doStream() {
      if (!fake.stream) throw new Error(`${modelId} has no stream fake`)
      return fake.stream({})
    },
  }
}

type Harness = {
  deps: RouterDeps
  calls: { resolved: string[]; generated: string[]; streamed: string[]; slept: number[] }
  logs: ReturnType<typeof collectLogs>
  quotaCalls: {
    rateLimit: unknown[]
    quota: unknown[]
    auth: unknown[]
    unsupported: unknown[]
    outage: unknown[]
  }
}

function collectLogs() {
  const events: Parameters<RouterDeps["log"]>[0][] = []
  return events
}

function harness(input: {
  models: Record<string, Fake>
  availability?: (candidate: ModelCandidate) => RouterAvailability
  authFingerprint?: () => string | undefined
  classify?: typeof classifyProviderError
}): Harness {
  const calls = {
    resolved: [] as string[],
    generated: [] as string[],
    streamed: [] as string[],
    slept: [] as number[],
  }
  const logs = collectLogs()
  const quotaCalls = {
    rateLimit: [] as unknown[],
    quota: [] as unknown[],
    auth: [] as unknown[],
    unsupported: [] as unknown[],
    outage: [] as unknown[],
  }

  const deps: RouterDeps = {
    resolve: (entry) => {
      calls.resolved.push(entry.modelId)
      const fake = input.models[entry.modelId]
      if (!fake) {
        return {
          ok: false,
          provider: entry.provider,
          modelId: entry.modelId,
          reason: "failed",
          detail: "no fake",
        }
      }
      return {
        ok: true,
        provider: entry.provider,
        modelId: entry.modelId,
        resolved: { model: fakeModel(entry.modelId, fake) },
      }
    },
    modelAvailability: input.availability ?? (() => ({ available: true })),
    authFingerprint: input.authFingerprint ?? (() => "fingerprint"),
    classify: input.classify ?? classifyProviderError,
    quota: {
      noteRequest: () => undefined,
      noteSuccess: () => undefined,
      noteFailure: () => undefined,
      noteRateLimit: (_provider, options) => {
        quotaCalls.rateLimit.push(options)
      },
      noteQuotaExhausted: (_provider, options) => {
        quotaCalls.quota.push(options)
      },
      noteAuthFailure: (_provider, fingerprint) => {
        quotaCalls.auth.push(fingerprint)
      },
      noteModelOutage: (_provider, modelId, detail) => {
        quotaCalls.outage.push({ modelId, detail })
      },
      noteProviderOutage: (_provider, detail) => {
        quotaCalls.outage.push(detail)
      },
      noteUnsupportedModel: (_provider, modelId, detail) => {
        quotaCalls.unsupported.push({ modelId, detail })
      },
    },
    sleep: async (ms) => {
      calls.slept.push(ms)
    },
    random: () => 0.5,
    now: () => Date.now(),
    log: (event) => {
      logs.push(event)
    },
    newRequestId: () => "req-test",
  }

  return { deps, calls, logs, quotaCalls }
}

function prompt(text = "hola"): AiCallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text }] }],
  }
}

function imagePrompt(): AiCallOptions {
  return {
    prompt: [
      {
        role: "user",
        content: [
          { type: "text", text: "¿Qué ves?" },
          { type: "file", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
        ],
      },
    ],
  }
}

async function readAll(stream: ReadableStream<AiStreamPart>) {
  const reader = stream.getReader()
  const parts: AiStreamPart[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) return parts
    parts.push(value)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("routing and fallback", () => {
  it("serves a normal request from OpenRouter", async () => {
    const { deps, calls, logs } = harness({
      models: { "or-general": { generate: () => textResult("hola desde openrouter") } },
    })

    const model = createRoutedModel({
      role: "general",
      candidates: [candidate("openrouter", "or-general")],
      deps,
    }) as unknown as AiLanguageModel

    const result = await model.doGenerate(prompt())
    const text = (result.content[0] as { text: string }).text

    expect(text).toBe("hola desde openrouter")
    expect(calls.generated).toEqual([])
    expect(calls.slept).toEqual([])
    expect(logs.at(-1)).toMatchObject({
      outcome: "success",
      provider: "openrouter",
      model: "or-general",
      attempts: 1,
      usedFallback: false,
    })
  })

  it("skips OpenRouter immediately on free-models-per-day and answers from Gemini", async () => {
    const { deps, calls, logs, quotaCalls } = harness({
      models: {
        "or-general": {
          generate: () => {
            throw quotaError()
          },
        },
        "gemini-general": { generate: () => textResult("hola desde gemini") },
      },
    })

    const model = createRoutedModel({
      role: "general",
      candidates: [
        candidate("openrouter", "or-general"),
        candidate("gemini", "gemini-general"),
      ],
      deps,
    }) as unknown as AiLanguageModel

    const result = await model.doGenerate(prompt())

    expect((result.content[0] as { text: string }).text).toBe("hola desde gemini")
    expect(calls.resolved).toEqual(["or-general", "gemini-general"])
    // No retry against the exhausted free allowance.
    expect(calls.slept).toEqual([])
    expect(quotaCalls.quota).toHaveLength(1)
    expect(quotaCalls.rateLimit).toHaveLength(0)
    expect(logs.at(-1)).toMatchObject({
      outcome: "success",
      provider: "gemini",
      usedFallback: true,
      fallbackReason: "quota_exhausted",
    })
  })

  it("falls back through Cerebras and Groq in provider order", async () => {
    const { deps, calls } = harness({
      models: {
        "or-general": {
          generate: () => {
            throw apiError({ status: 500, message: "overloaded" })
          },
        },
        "gemini-general": {
          generate: () => {
            throw new TypeError("fetch failed")
          },
        },
        "cerebras-general": {
          generate: () => {
            throw apiError({ status: 503, message: "busy" })
          },
        },
        "groq-general": { generate: () => textResult("hola desde groq") },
      },
    })

    const model = createRoutedModel({
      role: "general",
      maxRetriesPerCandidate: 0,
      candidates: [
        candidate("openrouter", "or-general"),
        candidate("gemini", "gemini-general"),
        candidate("cerebras", "cerebras-general"),
        candidate("groq", "groq-general"),
      ],
      deps,
    }) as unknown as AiLanguageModel

    const result = await model.doGenerate(prompt())
    expect((result.content[0] as { text: string }).text).toBe("hola desde groq")
    expect(calls.resolved).toEqual([
      "or-general",
      "gemini-general",
      "cerebras-general",
      "groq-general",
    ])
  })

  it("uses Cloudflare Workers AI for a compatible task", async () => {
    const { deps, logs } = harness({
      models: {
        "cf-fast": { generate: () => textResult("clasificado") },
      },
    })

    const model = createRoutedModel({
      role: "fast",
      candidates: [candidate("cloudflare", "cf-fast", ["streaming", "tools"])],
      deps,
    }) as unknown as AiLanguageModel

    const result = await model.doGenerate(prompt())
    expect((result.content[0] as { text: string }).text).toBe("clasificado")
    expect(logs.at(-1)).toMatchObject({ provider: "cloudflare" })
  })

  it("skips a provider that has no credentials without calling it", async () => {
    const { deps, calls } = harness({
      models: { "gemini-general": { generate: () => textResult("ok") } },
      availability: (entry) =>
        entry.provider === "openrouter"
          ? { available: false, reason: "unconfigured", detail: "missing OPENROUTER_API_KEY" }
          : { available: true },
    })

    const model = createRoutedModel({
      role: "general",
      candidates: [
        candidate("openrouter", "or-general"),
        candidate("gemini", "gemini-general"),
      ],
      deps,
    }) as unknown as AiLanguageModel

    await model.doGenerate(prompt())
    expect(calls.resolved).toEqual(["gemini-general"])
  })

  it("marks an invalid API key and stops calling that provider", async () => {
    const { deps, quotaCalls, calls } = harness({
      models: {
        "or-general": {
          generate: () => {
            throw apiError({ status: 401, body: { error: { message: "Invalid API key" } } })
          },
        },
        "gemini-general": { generate: () => textResult("ok") },
      },
    })

    const model = createRoutedModel({
      role: "general",
      candidates: [
        candidate("openrouter", "or-general"),
        candidate("gemini", "gemini-general"),
      ],
      deps,
    }) as unknown as AiLanguageModel

    await model.doGenerate(prompt())
    expect(quotaCalls.auth).toEqual(["fingerprint"])
    expect(calls.slept).toEqual([])
  })

  it("falls back when a provider never answers within its deadline", async () => {
    const { deps, calls } = harness({
      models: {
        "or-general": { generate: () => new Promise<AiGenerateResult>(() => {}) },
        "gemini-general": { generate: () => textResult("tarde pero bien") },
      },
    })

    const model = createRoutedModel({
      role: "general",
      attemptTimeoutMs: 25,
      maxRetriesPerCandidate: 0,
      candidates: [
        candidate("openrouter", "or-general"),
        candidate("gemini", "gemini-general"),
      ],
      deps,
    }) as unknown as AiLanguageModel

    const result = await model.doGenerate(prompt())
    expect((result.content[0] as { text: string }).text).toBe("tarde pero bien")
    expect(calls.resolved).toEqual(["or-general", "gemini-general"])
  })

  it("retries a transient 429 once, honouring Retry-After", async () => {
    let attempt = 0
    const { deps, calls } = harness({
      models: {
        "or-general": {
          generate: () => {
            attempt += 1
            if (attempt === 1) {
              throw apiError({
                status: 429,
                body: { error: { message: "upstream provider is rate-limited" } },
                headers: { "retry-after": "1" },
              })
            }
            return textResult("segundo intento")
          },
        },
      },
    })

    const model = createRoutedModel({
      role: "general",
      maxRetriesPerCandidate: 1,
      candidates: [candidate("openrouter", "or-general")],
      deps,
    }) as unknown as AiLanguageModel

    const result = await model.doGenerate(prompt())
    expect((result.content[0] as { text: string }).text).toBe("segundo intento")
    expect(attempt).toBe(2)
    expect(calls.slept).toEqual([1000])
  })

  it("returns a clear temporary-unavailability error when nothing is eligible", async () => {
    const { deps, logs } = harness({
      models: {
        "or-general": {
          generate: () => {
            throw apiError({ status: 500, message: "overloaded" })
          },
        },
        "gemini-general": {
          generate: () => {
            throw apiError({ status: 503, message: "busy" })
          },
        },
      },
    })

    const model = createRoutedModel({
      role: "general",
      maxRetriesPerCandidate: 0,
      candidates: [
        candidate("openrouter", "or-general"),
        candidate("gemini", "gemini-general"),
      ],
      deps,
    }) as unknown as AiLanguageModel

    await expect(model.doGenerate(prompt())).rejects.toThrow(AllProvidersFailedError)
    await expect(model.doGenerate(prompt())).rejects.toThrow(
      /No AI provider could answer the general request/
    )

    const failure = logs.find((event) => event.outcome === "failure")
    expect(failure).toMatchObject({ errorCategory: "server", attempts: 2 })
  })
})

describe("capability checks", () => {
  it("does not send an agent turn to a model without tool calling", () => {
    const plan = planForRole("general", {
      candidates: [
        candidate("openrouter", "text-only", ["streaming", "structuredOutput"]),
        candidate("gemini", "with-tools"),
      ],
    })

    expect(plan.candidates.map((entry) => entry.modelId)).toEqual(["with-tools"])
    expect(plan.unsupported).toEqual([
      expect.objectContaining({ candidate: expect.objectContaining({ modelId: "text-only" }), missing: ["tools"] }),
    ])
  })

  it("does not use a JSON-object-only model for structured output", async () => {
    const { deps } = harness({ models: {} })

    const model = createRoutedModel({
      role: "evaluator",
      candidates: [
        candidate("groq", "llama-json-object-only", ["streaming"]),
      ],
      deps,
    }) as unknown as AiLanguageModel

    await expect(model.doGenerate(prompt())).rejects.toThrow(/No AI provider could answer/)
  })

  it("routes an image prompt only to a vision-capable model", async () => {
    const { deps, calls } = harness({
      models: {
        "or-text": { generate: () => textResult("texto") },
        "gemini-vision": { generate: () => textResult("veo una captura") },
      },
    })

    const model = createRoutedModel({
      role: "general",
      candidates: [
        candidate("openrouter", "or-text"),
        candidate("gemini", "gemini-vision", ["streaming", "tools", "structuredOutput", "vision"]),
      ],
      deps,
    }) as unknown as AiLanguageModel

    const result = await model.doGenerate(imagePrompt())
    expect((result.content[0] as { text: string }).text).toBe("veo una captura")
    // The text-only model was filtered out before any provider call.
    expect(calls.resolved).toEqual(["gemini-vision"])
  })

  it("refuses a vision call when no vision model is configured", async () => {
    const { deps } = harness({
      models: { "or-text": { generate: () => textResult("texto") } },
    })

    const model = createRoutedModel({
      role: "vision",
      candidates: [candidate("openrouter", "or-text")],
      deps,
    }) as unknown as AiLanguageModel

    let error: unknown
    try {
      await model.doGenerate(imagePrompt())
    } catch (failure) {
      error = failure
    }
    expect(error).toBeInstanceOf(AllProvidersFailedError)
    expect((error as AllProvidersFailedError).reason).toBe("no_eligible_model")
  })
})

describe("streaming and cancellation", () => {
  it("streams text and records usage", async () => {
    const { deps, logs } = harness({
      models: {
        "or-general": {
          stream: () =>
            streamResult([
              { type: "stream-start" },
              { type: "text-delta", delta: "Hola" },
              { type: "finish", usage: { inputTokens: 12, outputTokens: 3 } },
            ]),
        },
      },
    })

    const model = createRoutedModel({
      role: "general",
      candidates: [candidate("openrouter", "or-general")],
      deps,
    }) as unknown as AiLanguageModel

    const result = await model.doStream(prompt())
    const parts = await readAll(result.stream)

    expect(parts.map((part) => part.type)).toEqual(["stream-start", "text-delta", "finish"])
    expect(logs.at(-1)).toMatchObject({
      outcome: "success",
      provider: "openrouter",
      inputTokens: 12,
      outputTokens: 3,
    })
  })

  it("falls back when a stream fails before the first output", async () => {
    const { deps, calls } = harness({
      models: {
        "or-general": {
          stream: () =>
            streamResult([
              { type: "stream-start" },
              { type: "error", error: quotaError() },
            ]),
        },
        "gemini-general": {
          stream: () => streamResult([{ type: "text-delta", delta: "Hola" }]),
        },
      },
    })

    const model = createRoutedModel({
      role: "general",
      candidates: [
        candidate("openrouter", "or-general"),
        candidate("gemini", "gemini-general"),
      ],
      deps,
    }) as unknown as AiLanguageModel

    const result = await model.doStream(prompt())
    const parts = await readAll(result.stream)
    const text = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")

    expect(text).toBe("Hola")
    expect(calls.resolved).toEqual(["or-general", "gemini-general"])
  })

  it("does not replay content when a stream fails after it started", async () => {
    const { deps, calls } = harness({
      models: {
        "or-general": {
          stream: () =>
            streamResult([
              { type: "text-delta", delta: "parcial" },
              { type: "error", error: apiError({ status: 500, message: "stream died" }) },
            ]),
        },
        "gemini-general": {
          stream: () => streamResult([{ type: "text-delta", delta: "no debería verse" }]),
        },
      },
    })

    const model = createRoutedModel({
      role: "general",
      candidates: [
        candidate("openrouter", "or-general"),
        candidate("gemini", "gemini-general"),
      ],
      deps,
    }) as unknown as AiLanguageModel

    const result = await model.doStream(prompt())
    const seen = await readAll(result.stream)

    // The chunk the person already received is kept, and the failure is the
    // last part: no other provider runs and nothing is duplicated.
    expect(seen.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual([
      "parcial",
    ])
    expect(seen.at(-1)).toMatchObject({ type: "error" })
    expect(calls.resolved).toEqual(["or-general"])
  })

  it("cancels the provider stream when the client cancels", async () => {
    let cancelled = false
    const { deps, logs } = harness({
      models: {
        "or-general": { stream: () => hangingStream(() => { cancelled = true }) },
      },
    })

    const model = createRoutedModel({
      role: "general",
      candidates: [candidate("openrouter", "or-general")],
      deps,
    }) as unknown as AiLanguageModel

    const result = await model.doStream(prompt())
    const reader = result.stream.getReader()
    const first = await reader.read()
    expect(first.value).toMatchObject({ type: "text-delta", delta: "parcial" })

    await reader.cancel()
    expect(cancelled).toBe(true)
    expect(logs.at(-1)).toMatchObject({ errorCategory: "aborted" })
  })

  it("does not call a provider when the request is already aborted", async () => {
    const { deps, calls } = harness({
      models: { "or-general": { generate: () => textResult("no") } },
    })

    const model = createRoutedModel({
      role: "general",
      candidates: [candidate("openrouter", "or-general")],
      deps,
    }) as unknown as AiLanguageModel

    const controller = new AbortController()
    controller.abort()

    await expect(
      model.doGenerate({ ...prompt(), abortSignal: controller.signal })
    ).rejects.toThrow()
    expect(calls.resolved).toEqual([])
  })

  it("keeps concurrent requests independent", async () => {
    let geminiCalls = 0
    const { deps, quotaCalls } = harness({
      models: {
        "or-general": {
          generate: () => {
            throw quotaError()
          },
        },
        "gemini-general": {
          generate: () => {
            geminiCalls += 1
            return textResult(`respuesta ${geminiCalls}`)
          },
        },
      },
    })

    const candidates = [
      candidate("openrouter", "or-general"),
      candidate("gemini", "gemini-general"),
    ]

    const results = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const model = createRoutedModel({ role: "general", candidates, deps })
        const result = await (model as unknown as AiLanguageModel).doGenerate(prompt())
        return (result.content[0] as { text: string }).text
      })
    )

    expect(results).toHaveLength(10)
    expect(new Set(results).size).toBe(10)
    expect(geminiCalls).toBe(10)
    expect(quotaCalls.quota).toHaveLength(10)
  })
})
