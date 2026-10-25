import type { LanguageModel } from "ai"

import {
  AllProvidersFailedError,
  ModelDeadlineError,
  backoffDelayMs,
  classifyProviderError,
  sleep,
  type ClassifiedError,
  type FailedAttempt,
} from "./fallback"
import {
  ROLE_DEADLINES,
  ROLE_REQUIREMENTS,
  catalogForRole,
  missingCapabilities,
} from "./models"
import { logAiEvent, newRequestId, type AiLogEvent } from "./observability"
import {
  credentialFingerprint,
  resolveCandidate,
  type ResolvedModel,
} from "./provider-registry"
import * as quota from "./quota-manager"
import type {
  AiCallOptions,
  AiGenerateResult,
  AiLanguageModel,
  AiStreamPart,
  AiStreamResult,
  ModelCandidate,
  ModelRequirements,
  ModelRole,
  ProviderId,
  ProviderModel,
  UsageInfo,
} from "./types"

/**
 * The one model router.
 *
 * Every agent role — chat, browser, computer, social, code, routing and agent
 * drafting — gets its model from here. The router:
 *
 *   1. builds the candidate plan for a role (capability-filtered, provider order
 *      configurable) and refuses any model that cannot do the required job;
 *   2. skips providers without credentials, providers in cooldown, and models
 *      whose own cooldown is running;
 *   3. gives each attempt a deadline for its first output, so a hung provider
 *      cannot stall a turn;
 *   4. classifies a failure — daily quota, transient 429, auth, timeout,
 *      unsupported model — and reacts accordingly: a daily quota or auth error
 *      moves on immediately, a transient 5xx or timeout gets one bounded retry
 *      with exponential backoff and jitter;
 *   5. falls back to the next provider only before any content has been sent.
 *      Once output has started, a failure ends the stream honestly instead of
 *      duplicating what the person already saw.
 *
 * The model it returns implements the AI SDK v4 language-model shape, so
 * `streamText`, `generateText` and `generateObject` use it like a provider model.
 */

/** Why a candidate cannot be called right now, without leaking any detail. */
export type RouterAvailability = {
  available: boolean
  reason?: quota.CooldownReason | "unconfigured"
  detail?: string
  until?: number
}

export type RouterDeps = {
  resolve: (
    candidate: ModelCandidate,
    role: ModelRole,
    options: { serverFallbackModels?: string[] }
  ) => ResolvedModel
  modelAvailability: (candidate: ModelCandidate) => RouterAvailability
  authFingerprint: (provider: ProviderId) => string | undefined
  classify: (error: unknown, provider: ProviderId) => ClassifiedError
  quota: {
    noteRequest: typeof quota.noteRequest
    noteSuccess: typeof quota.noteSuccess
    noteFailure: typeof quota.noteFailure
    noteRateLimit: typeof quota.noteRateLimit
    noteQuotaExhausted: typeof quota.noteQuotaExhausted
    noteAuthFailure: typeof quota.noteAuthFailure
    noteModelOutage: typeof quota.noteModelOutage
    noteProviderOutage: typeof quota.noteProviderOutage
    noteUnsupportedModel: typeof quota.noteUnsupportedModel
  }
  sleep: (ms: number) => Promise<void>
  random: () => number
  now: () => number
  log: (event: AiLogEvent) => void
  newRequestId: () => string
}

function defaultDeps(): RouterDeps {
  return {
    resolve: resolveCandidate,
    modelAvailability: (candidate) =>
      quota.modelAvailability(
        candidate.provider,
        candidate.modelId,
        credentialFingerprint(candidate.provider)
      ),
    authFingerprint: credentialFingerprint,
    classify: classifyProviderError,
    quota: {
      noteRequest: quota.noteRequest,
      noteSuccess: quota.noteSuccess,
      noteFailure: quota.noteFailure,
      noteRateLimit: quota.noteRateLimit,
      noteQuotaExhausted: quota.noteQuotaExhausted,
      noteAuthFailure: quota.noteAuthFailure,
      noteModelOutage: quota.noteModelOutage,
      noteProviderOutage: quota.noteProviderOutage,
      noteUnsupportedModel: quota.noteUnsupportedModel,
    },
    sleep,
    random: Math.random,
    now: Date.now,
    log: logAiEvent,
    newRequestId,
  }
}

export type RoutedModelOptions = {
  role: ModelRole
  /** Used in logs only; it never changes the prompt. */
  agentKind?: string
  /** Extra capabilities this call needs beyond the role's defaults. */
  requirements?: ModelRequirements
  /** Explicit plan, for tests or a caller that knows better. */
  candidates?: ModelCandidate[]
  deps?: Partial<RouterDeps>
  /** Hard cap on provider calls for one request (default 6). */
  maxProviderCalls?: number
  /** Retries of the same model on transient failures (default 1). */
  maxRetriesPerCandidate?: number
  /** Overrides every rung deadline, for tests. */
  attemptTimeoutMs?: number
}

export type RolePlan = {
  role: ModelRole
  required: ModelRequirements
  /** Eligible candidates, in routing order. */
  candidates: ModelCandidate[]
  /** Candidates the role cannot use, and exactly what they lack. */
  unsupported: { candidate: ModelCandidate; missing: string[] }[]
}

export function requirementsFor(
  role: ModelRole,
  extra?: ModelRequirements
): ModelRequirements {
  return { ...ROLE_REQUIREMENTS[role], ...extra }
}

/**
 * The plan for a role. Capability gaps are reported, not silently dropped: a
 * model that cannot take tools is never used for an agent turn.
 */
function buildPlan(
  role: ModelRole,
  required: ModelRequirements,
  all: ModelCandidate[]
): RolePlan {
  const candidates: ModelCandidate[] = []
  const unsupported: RolePlan["unsupported"] = []

  for (const candidate of all) {
    const missing = missingCapabilities(candidate, required)
    if (missing.length === 0) candidates.push(candidate)
    else unsupported.push({ candidate, missing })
  }

  return { role, required, candidates, unsupported }
}

export function planForRole(
  role: ModelRole,
  options: Pick<RoutedModelOptions, "requirements" | "candidates"> = {}
): RolePlan {
  return buildPlan(
    role,
    requirementsFor(role, options.requirements),
    options.candidates ?? catalogForRole(role)
  )
}

/**
 * True when the prompt carries an image (a screenshot, a photo, a PDF page
 * rendered as an image). Such a call must go to a vision-capable model, whatever
 * the role usually accepts.
 */
export function promptHasImage(callOptions: AiCallOptions): boolean {
  const prompt = callOptions.prompt
  if (!Array.isArray(prompt)) return false

  for (const message of prompt) {
    if (!message || typeof message !== "object") continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue

    for (const part of content) {
      if (!part || typeof part !== "object") continue
      const record = part as { type?: unknown; mediaType?: unknown }
      if (record.type === "image") return true
      if (
        record.type === "file" &&
        typeof record.mediaType === "string" &&
        record.mediaType.startsWith("image/")
      ) {
        return true
      }
    }
  }

  return false
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error("The request was aborted")
  error.name = "AbortError"
  return error
}

function mergeProviderOptions(
  callOptions: AiCallOptions,
  resolved: ProviderModel
): Record<string, Record<string, unknown>> | undefined {
  if (!callOptions.providerOptions && !resolved.providerOptions) return undefined
  return {
    ...callOptions.providerOptions,
    ...resolved.providerOptions,
  }
}

function readUsage(usage: unknown): UsageInfo | undefined {
  if (!usage || typeof usage !== "object") return undefined
  const record = usage as Record<string, unknown>
  const num = (key: string): number | undefined =>
    typeof record[key] === "number" && Number.isFinite(record[key] as number)
      ? (record[key] as number)
      : undefined

  const inputTokens = num("inputTokens") ?? num("promptTokens")
  const outputTokens = num("outputTokens") ?? num("completionTokens")
  const totalTokens = num("totalTokens")

  const info: UsageInfo = {
    ...(inputTokens != null && { inputTokens }),
    ...(outputTokens != null && { outputTokens }),
    ...(totalTokens != null && { totalTokens }),
  }

  // Workers AI returns its Neuron cost inside the raw usage object; it is a
  // different unit from tokens and is stored separately.
  const raw = record.raw
  if (raw && typeof raw === "object") {
    const neurons = (raw as Record<string, unknown>).neurons
    if (typeof neurons === "number" && Number.isFinite(neurons)) {
      info.units = { neurons }
    }
  }

  return Object.keys(info).length > 0 ? info : undefined
}

/** A stream part that a person would see. Used to decide when fallback stops. */
function isContentPart(part: AiStreamPart): boolean {
  switch (part.type) {
    case "text-delta":
    case "reasoning-delta":
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-call":
    case "tool-result":
    case "file":
    case "source":
      return true
    default:
      return false
  }
}

type AttemptOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown }

/**
 * Runs one provider call with a deadline and abort propagation.
 *
 * The deadline rejects on its own instead of trusting the SDK to honour the
 * signal, because an SDK that ignored it would hang the turn. Listeners are
 * always removed, so a long turn with many attempts cannot pile up listeners on
 * the caller's signal (the source of `MaxListenersExceededWarning`).
 */
async function callWithDeadline<T>(args: {
  run: (signal: AbortSignal) => PromiseLike<T>
  parentSignal?: AbortSignal
  deadlineMs: number
  modelId: string
}): Promise<AttemptOutcome<T>> {
  const { run, parentSignal, deadlineMs, modelId } = args
  if (parentSignal?.aborted) return { ok: false, error: abortError(parentSignal) }

  const attempt = new AbortController()
  const forward = () => attempt.abort(parentSignal ? abortError(parentSignal) : undefined)
  parentSignal?.addEventListener("abort", forward, { once: true })

  let rejectOnAbort: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = reject
  })
  const onAttemptAbort = () => rejectOnAbort?.(attempt.signal.reason)
  attempt.signal.addEventListener("abort", onAttemptAbort, { once: true })

  const timer = setTimeout(() => {
    attempt.abort(new ModelDeadlineError(modelId, deadlineMs))
  }, deadlineMs)

  try {
    return {
      ok: true,
      value: await Promise.race([Promise.resolve(run(attempt.signal)), aborted]),
    }
  } catch (error) {
    return { ok: false, error }
  } finally {
    clearTimeout(timer)
    attempt.signal.removeEventListener("abort", onAttemptAbort)
    parentSignal?.removeEventListener("abort", forward)
  }
}

async function cancelQuietly(
  reader: ReadableStreamDefaultReader<AiStreamPart> | undefined
): Promise<void> {
  if (!reader) return
  try {
    await reader.cancel("cancelled")
  } catch {
    // Cancelling a stream that is already closing is not an error.
  }
}

export function createRoutedModel(options: RoutedModelOptions): LanguageModel {
  const deps: RouterDeps = { ...defaultDeps(), ...options.deps }
  const role = options.role
  const plan = planForRole(role, options)
  const maxProviderCalls =
    options.maxProviderCalls ??
    (Number(process.env.PARADOX_AI_MAX_PROVIDER_CALLS) || 6)
  const maxRetriesPerCandidate =
    options.maxRetriesPerCandidate ??
    (Number.isFinite(Number(process.env.PARADOX_AI_MAX_RETRIES))
      ? Number(process.env.PARADOX_AI_MAX_RETRIES)
      : 1)

  function deadlineFor(index: number): number {
    if (options.attemptTimeoutMs != null) return options.attemptTimeoutMs
    const ladder = ROLE_DEADLINES[role]
    return ladder[Math.min(index, ladder.length - 1)] ?? 15_000
  }

  /** Same-provider models OpenRouter may fall back to on its own. */
  function serverFallbacksFor(
    index: number,
    candidate: ModelCandidate,
    candidates: ModelCandidate[]
  ): string[] {
    if (candidate.provider !== "openrouter") return []
    return candidates
      .slice(index + 1)
      .filter((entry) => entry.provider === "openrouter")
      .slice(0, 2)
      .map((entry) => entry.modelId)
  }

  /**
   * Records what the failure means for the provider so the next request skips
   * it instead of rediscovering the same problem.
   */
  function applyCooldown(candidate: ModelCandidate, classified: ClassifiedError) {
    const detail = classified.message
    switch (classified.category) {
      case "quota_exhausted":
        deps.quota.noteQuotaExhausted(candidate.provider, {
          modelId: candidate.modelId,
          retryAfterMs: classified.retryAfterMs,
          resetsAt: classified.resetsAt,
          detail,
        })
        break
      case "rate_limited":
        deps.quota.noteRateLimit(candidate.provider, {
          modelId: candidate.modelId,
          daily: false,
          retryAfterMs: classified.retryAfterMs,
          detail,
        })
        break
      case "auth":
        deps.quota.noteAuthFailure(
          candidate.provider,
          deps.authFingerprint(candidate.provider) ?? "unknown",
          detail
        )
        break
      case "unsupported":
        deps.quota.noteUnsupportedModel(candidate.provider, candidate.modelId, detail)
        break
      case "server":
        deps.quota.noteModelOutage(candidate.provider, candidate.modelId, detail)
        break
      case "network":
        // A network failure means the provider could not be reached at all.
        deps.quota.noteProviderOutage(candidate.provider, detail)
        break
      default:
        break
    }
  }

  function describeSkip(
    candidate: ModelCandidate,
    reason: string,
    detail?: string
  ): FailedAttempt {
    const category: FailedAttempt["category"] =
      reason === "quota_exhausted"
        ? "quota_exhausted"
        : reason === "rate_limited"
          ? "rate_limited"
          : reason === "auth"
            ? "auth"
            : reason === "unsupported_model"
              ? "unsupported"
              : reason === "unconfigured"
                ? "unconfigured"
                : "cooldown"

    return {
      provider: candidate.provider,
      modelId: candidate.modelId,
      category,
      message: detail ? `${reason}: ${detail}` : reason,
    }
  }

  /**
   * The plan for one call. A prompt that carries an image raises the
   * requirement to vision, so the router never sends a screenshot to a text
   * model and never silently drops it.
   */
  function planForCall(callOptions: AiCallOptions): RolePlan {
    const wantsVision = promptHasImage(callOptions)
    const required = requirementsFor(role, {
      ...options.requirements,
      ...(wantsVision && { vision: true }),
    })
    return buildPlan(role, required, options.candidates ?? catalogForRole(role))
  }

  function emptyPlanError(plan: RolePlan, failures: FailedAttempt[]) {
    const unsupported = plan.unsupported.map((entry) => ({
      provider: entry.candidate.provider,
      modelId: entry.candidate.modelId,
      category: "unsupported" as const,
      message: `missing ${entry.missing.join(", ")}`,
    }))

    const reason =
      plan.candidates.length === 0
        ? "no_eligible_model"
        : failures.length > 0 &&
            failures.every((entry) => entry.category === "unconfigured")
          ? "none_configured"
          : "all_failed"

    return new AllProvidersFailedError(
      role,
      [...failures, ...unsupported].slice(0, 12),
      null,
      reason
    )
  }

  async function doGenerate(callOptions: AiCallOptions): Promise<AiGenerateResult> {
    const depsNow = deps
    const requestId = depsNow.newRequestId()
    const startedAt = depsNow.now()
    const parent = new AbortController()
    const outer = callOptions.abortSignal
    const forwardOuter = () => parent.abort(outer ? abortError(outer) : undefined)
    if (outer?.aborted) throw abortError(outer)
    outer?.addEventListener("abort", forwardOuter, { once: true })

    const callPlan = planForCall(callOptions)
    const failures: FailedAttempt[] = []
    let calls = 0
    let lastProvider: string | undefined
    let lastModel: string | undefined
    let usedFallback = false
    let lastCategory: string | undefined

    try {
      for (let index = 0; index < callPlan.candidates.length; index++) {
        const candidate = callPlan.candidates[index]
        if (parent.signal.aborted) throw abortError(parent.signal)
        if (calls >= maxProviderCalls) break

        const availability = depsNow.modelAvailability(candidate)
        if (!availability.available) {
          failures.push(describeSkip(candidate, availability.reason ?? "cooldown", availability.detail))
          usedFallback = true
          // A provider that was never called is a weaker explanation than one
          // that answered with an error, so it only fills an empty slot.
          lastCategory ??= availability.reason ?? "cooldown"
          continue
        }

        const resolved = depsNow.resolve(candidate, role, {
          serverFallbackModels: serverFallbacksFor(index, candidate, callPlan.candidates),
        })
        if (!resolved.ok) {
          failures.push(describeSkip(candidate, resolved.reason, resolved.detail))
          usedFallback = true
          lastCategory ??= resolved.reason
          continue
        }

        for (let retry = 0; retry <= maxRetriesPerCandidate; retry++) {
          if (parent.signal.aborted) throw abortError(parent.signal)
          if (calls >= maxProviderCalls) break

          calls += 1
          depsNow.quota.noteRequest(candidate.provider)
          lastProvider = candidate.provider
          lastModel = candidate.modelId
          if (index > 0) usedFallback = true

          const model = resolved.resolved.model as AiLanguageModel
          const attemptStarted = depsNow.now()
          const outcome = await callWithDeadline({
            modelId: candidate.modelId,
            parentSignal: parent.signal,
            deadlineMs: deadlineFor(index),
            run: (signal) =>
              model.doGenerate({
                ...callOptions,
                abortSignal: signal,
                providerOptions: mergeProviderOptions(callOptions, resolved.resolved),
              }),
          })

          if (outcome.ok) {
            const latencyMs = depsNow.now() - attemptStarted
            const usage = readUsage(outcome.value.usage)
            depsNow.quota.noteSuccess(candidate.provider, candidate.modelId, {
              latencyMs,
              ...(usage && { usage }),
              ...(usage?.units && { units: usage.units }),
            })
            depsNow.log({
              event: "ai.request",
              role,
              agentKind: options.agentKind,
              requestId,
              outcome: "success",
              provider: candidate.provider,
              model: candidate.modelId,
              latencyMs: depsNow.now() - startedAt,
              usedFallback,
              ...(usedFallback && failures[0] && {
                fallbackFrom: `${failures[0].provider}/${failures[0].modelId}`,
                fallbackReason: failures[0].category,
              }),
              attempts: calls,
              ...(readUsage(outcome.value.usage)?.inputTokens != null && {
                inputTokens: readUsage(outcome.value.usage)?.inputTokens,
              }),
              ...(readUsage(outcome.value.usage)?.outputTokens != null && {
                outputTokens: readUsage(outcome.value.usage)?.outputTokens,
              }),
            })
            return outcome.value
          }

          if (parent.signal.aborted) throw abortError(parent.signal)

          const classified = depsNow.classify(outcome.error, candidate.provider)
          lastCategory = classified.category
          depsNow.quota.noteFailure(candidate.provider, candidate.modelId, {
            category: classified.category,
            latencyMs: depsNow.now() - attemptStarted,
          })
          applyCooldown(candidate, classified)
          failures.push({
            provider: candidate.provider,
            modelId: candidate.modelId,
            category: classified.category,
            message: classified.message,
          })

          if (classified.category === "aborted") throw toError(outcome.error)

          // Unsupported capabilities and exhausted quotas are not retried on
          // the same model: another model is the only thing that can help.
          if (!classified.retryable || retry >= maxRetriesPerCandidate) break

          const delay = classified.retryAfterMs ?? backoffDelayMs(retry, { random: depsNow.random })
          await depsNow.sleep(delay)
        }
      }

      depsNow.log({
        event: "ai.request",
        role,
        agentKind: options.agentKind,
        requestId,
        outcome: "failure",
        ...(lastProvider && { provider: lastProvider }),
        ...(lastModel && { model: lastModel }),
        latencyMs: depsNow.now() - startedAt,
        usedFallback,
        attempts: calls,
        ...(lastCategory && { errorCategory: lastCategory }),
      })
      throw emptyPlanError(callPlan, failures)
    } finally {
      outer?.removeEventListener("abort", forwardOuter)
    }
  }

  async function doStream(callOptions: AiCallOptions): Promise<AiStreamResult> {
    const depsNow = deps
    const requestId = depsNow.newRequestId()
    const startedAt = depsNow.now()
    const parent = new AbortController()
    const outer = callOptions.abortSignal
    const forwardOuter = () => parent.abort(outer ? abortError(outer) : undefined)
    if (outer?.aborted) throw abortError(outer)
    outer?.addEventListener("abort", forwardOuter, { once: true })

    const callPlan = planForCall(callOptions)
    const failures: FailedAttempt[] = []
    let calls = 0
    let usedFallback = false
    let lastCategory: string | undefined

    type Started = {
      candidate: ModelCandidate
      resolved: ProviderModel
      result: AiStreamResult
      reader: ReadableStreamDefaultReader<AiStreamPart>
      buffered: AiStreamPart[]
      startedAt: number
    }

    let started: Started | undefined

    const detachOuter = () => outer?.removeEventListener("abort", forwardOuter)

    try {
      for (let index = 0; index < callPlan.candidates.length && !started; index++) {
        const candidate = callPlan.candidates[index]
        if (parent.signal.aborted) throw abortError(parent.signal)
        if (calls >= maxProviderCalls) break

        const availability = depsNow.modelAvailability(candidate)
        if (!availability.available) {
          failures.push(describeSkip(candidate, availability.reason ?? "cooldown", availability.detail))
          usedFallback = true
          // A provider that was never called is a weaker explanation than one
          // that answered with an error, so it only fills an empty slot.
          lastCategory ??= availability.reason ?? "cooldown"
          continue
        }

        const resolved = depsNow.resolve(candidate, role, {
          serverFallbackModels: serverFallbacksFor(index, candidate, callPlan.candidates),
        })
        if (!resolved.ok) {
          failures.push(describeSkip(candidate, resolved.reason, resolved.detail))
          usedFallback = true
          lastCategory ??= resolved.reason
          continue
        }

        for (let retry = 0; retry <= maxRetriesPerCandidate && !started; retry++) {
          if (parent.signal.aborted) throw abortError(parent.signal)
          if (calls >= maxProviderCalls) break

          calls += 1
          depsNow.quota.noteRequest(candidate.provider)
          if (index > 0) usedFallback = true

          const model = resolved.resolved.model as AiLanguageModel
          const attemptStarted = depsNow.now()
          const outcome = await callWithDeadline({
            modelId: candidate.modelId,
            parentSignal: parent.signal,
            deadlineMs: deadlineFor(index),
            run: (signal) =>
              model.doStream({
                ...callOptions,
                abortSignal: signal,
                providerOptions: mergeProviderOptions(callOptions, resolved.resolved),
              }),
          })

          if (!outcome.ok) {
            if (parent.signal.aborted) throw abortError(parent.signal)
            const classified = depsNow.classify(outcome.error, candidate.provider)
            lastCategory = classified.category
            depsNow.quota.noteFailure(candidate.provider, candidate.modelId, {
              category: classified.category,
              latencyMs: depsNow.now() - attemptStarted,
            })
            applyCooldown(candidate, classified)
            failures.push({
              provider: candidate.provider,
              modelId: candidate.modelId,
              category: classified.category,
              message: classified.message,
            })
            if (classified.category === "aborted") throw toError(outcome.error)
            if (!classified.retryable || retry >= maxRetriesPerCandidate) break
            const delay = classified.retryAfterMs ?? backoffDelayMs(retry, { random: depsNow.random })
            await depsNow.sleep(delay)
            continue
          }

          const result = outcome.value
          const reader = result.stream.getReader()
          const buffered: AiStreamPart[] = []
          let failedBeforeContent = false
          let contentSeen = false
          let failure: unknown

          // Wait for the first part that a person would see. Anything before it
          // (stream-start, metadata, an error) can still be retried losslessly.
          try {
            while (!contentSeen) {
              const { done, value } = await reader.read()
              if (done) break
              if (value.type === "error") {
                failure = toError(value.error ?? "model stream failed")
                failedBeforeContent = true
                break
              }
              buffered.push(value)
              if (isContentPart(value)) contentSeen = true
            }
          } catch (error) {
            failedBeforeContent = true
            failure = error
          }

          if (failedBeforeContent) {
            await cancelQuietly(reader)
            if (parent.signal.aborted) throw abortError(parent.signal)
            const classified = depsNow.classify(failure, candidate.provider)
            lastCategory = classified.category
            depsNow.quota.noteFailure(candidate.provider, candidate.modelId, {
              category: classified.category,
              latencyMs: depsNow.now() - attemptStarted,
            })
            applyCooldown(candidate, classified)
            failures.push({
              provider: candidate.provider,
              modelId: candidate.modelId,
              category: classified.category,
              message: classified.message,
            })
            if (classified.category === "aborted") throw toError(failure)
            if (!classified.retryable || retry >= maxRetriesPerCandidate) break
            const delay = classified.retryAfterMs ?? backoffDelayMs(retry, { random: depsNow.random })
            await depsNow.sleep(delay)
            continue
          }

          started = {
            candidate,
            resolved: resolved.resolved,
            result,
            reader,
            buffered,
            startedAt: attemptStarted,
          }
        }
      }

      if (!started) {
        depsNow.log({
          event: "ai.request",
          role,
          agentKind: options.agentKind,
          requestId,
          outcome: "failure",
          latencyMs: depsNow.now() - startedAt,
          usedFallback,
          attempts: calls,
          ...(lastCategory && { errorCategory: lastCategory }),
        })
        detachOuter()
        throw emptyPlanError(callPlan, failures)
      }
    } catch (error) {
      detachOuter()
      throw error
    }

    const chosen = started
    let settled = false
    let usage: UsageInfo | undefined
    let partial = false
    let streamController: ReadableStreamController<AiStreamPart> | undefined

    const stream = new ReadableStream<AiStreamPart>({
      start(controller) {
        streamController = controller
        const onAbort = () => {
          void cancelQuietly(chosen.reader)
        }
        outer?.addEventListener("abort", onAbort, { once: true })

        void (async () => {
          try {
            for (const part of chosen.buffered) controller.enqueue(part)

            while (true) {
              const { done, value } = await chosen.reader.read()
              if (done) break
              if (value.type === "error") {
                throw toError(value.error ?? "model stream failed")
              }
              if (value.type === "finish") usage = readUsage(value.usage) ?? readUsage(value.totalUsage)
              controller.enqueue(value)
            }

            // The consumer cancelled while this read was pending: the cancel
            // handler already reported the outcome.
            if (settled) return

            depsNow.quota.noteSuccess(chosen.candidate.provider, chosen.candidate.modelId, {
              latencyMs: depsNow.now() - chosen.startedAt,
              ...(usage && { usage }),
              ...(usage?.units && { units: usage.units }),
            })
            depsNow.log({
              event: "ai.request",
              role,
              agentKind: options.agentKind,
              requestId,
              outcome: "success",
              provider: chosen.candidate.provider,
              model: chosen.candidate.modelId,
              latencyMs: depsNow.now() - startedAt,
              usedFallback,
              attempts: calls,
              ...(usage?.inputTokens != null && { inputTokens: usage.inputTokens }),
              ...(usage?.outputTokens != null && { outputTokens: usage.outputTokens }),
            })
            if (settled) return
            settled = true
            detachOuter()
            outer?.removeEventListener("abort", onAbort)
            controller.close()
          } catch (error) {
            if (settled) return
            settled = true
            detachOuter()
            outer?.removeEventListener("abort", onAbort)

            const classified = depsNow.classify(error, chosen.candidate.provider)
            depsNow.quota.noteFailure(chosen.candidate.provider, chosen.candidate.modelId, {
              category: classified.category,
              latencyMs: depsNow.now() - chosen.startedAt,
            })
            applyCooldown(chosen.candidate, classified)
            partial = true

            depsNow.log({
              event: "ai.request",
              role,
              agentKind: options.agentKind,
              requestId,
              outcome: "failure",
              provider: chosen.candidate.provider,
              model: chosen.candidate.modelId,
              latencyMs: depsNow.now() - startedAt,
              usedFallback,
              attempts: calls,
              errorCategory: classified.category,
              partial,
            })

            // Content already reached the person: the failure is emitted as the
            // final error part (an erroring stream would discard the chunks
            // still queued), and no other provider is tried. Nothing is
            // duplicated and the partial answer is not lost.
            try {
              controller.enqueue({
                type: "error",
                error: parent.signal.aborted ? abortError(parent.signal) : error,
              })
              controller.close()
            } catch {
              // The consumer is already gone; nothing left to report to.
            }
          } finally {
            outer?.removeEventListener("abort", onAbort)
          }
        })()
      },

      async cancel(reason) {
        if (settled) return
        settled = true
        detachOuter()
        await cancelQuietly(chosen.reader).catch(() => undefined)
        // Close the controller to prevent new listeners from being added
        // to the underlying ServerResponse. Without this, the Next.js server
        // keeps attaching close listeners for connection tracking.
        try {
          streamController?.close()
        } catch {
          // Controller already closed
        }
        depsNow.log({
          event: "ai.request",
          role,
          agentKind: options.agentKind,
          requestId,
          outcome: "failure",
          provider: chosen.candidate.provider,
          model: chosen.candidate.modelId,
          latencyMs: depsNow.now() - startedAt,
          usedFallback,
          attempts: calls,
          errorCategory: "aborted",
          partial,
        })
        void reason
      },
    })

    return { ...chosen.result, stream }
  }

  return {
    specificationVersion: "v4",
    provider: "paradox-router",
    modelId: plan.candidates[0]?.modelId ?? "unavailable",
    supportedUrls:
      plan.required.vision === true ? { "image/*": [/^https?:\/\//] } : {},
    doGenerate,
    doStream,
  } as unknown as LanguageModel
}

/** One line describing the routing plan for a role, for diagnostics/tests. */
export function describePlan(role: ModelRole, options: RoutedModelOptions = { role }): string {
  const plan = planForRole(role, options)
  const eligible = plan.candidates.map((entry) => `${entry.provider}:${entry.modelId}`)
  return eligible.join(" -> ") || `(no ${role} model is eligible)`
}
