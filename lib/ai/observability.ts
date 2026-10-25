import { randomUUID } from "node:crypto"

/**
 * Structured logs for the AI layer.
 *
 * What is logged: provider, model, role, agent kind, request id, latency,
 * fallback reason, error category, token counts and cost.
 * What is never logged: API keys, prompts, message content, tool arguments or
 * model output. Error messages are truncated and redacted by `fallback.ts`.
 */

export type AiLogEvent = {
  event: "ai.request"
  /** Model role, never the agent's private instructions. */
  role: string
  agentKind?: string
  requestId: string
  outcome: "success" | "failure"
  provider?: string
  model?: string
  /** Milliseconds from the first attempt to the answer. */
  latencyMs?: number
  /** True when an earlier provider had to be skipped or failed. */
  usedFallback?: boolean
  /** `provider/model of the first rung` + why it was left. */
  fallbackFrom?: string
  fallbackReason?: string
  /** Number of provider calls spent on this request. */
  attempts?: number
  errorCategory?: string
  /** Stream that died after content reached the person. */
  partial?: boolean
  inputTokens?: number
  outputTokens?: number
  costMicros?: number
}

export function newRequestId(): string {
  return randomUUID()
}

/**
 * One line per model request. `console.warn` for failures so a log pipeline can
 * filter on it; the JSON payload is stable and safe to index.
 */
export function logAiEvent(event: AiLogEvent): void {
  const { event: name, outcome, ...fields } = event
  const payload = JSON.stringify({ ...fields, outcome })
  const line = `[${name}] ${payload}`
  if (outcome === "failure") console.warn(line)
  else console.info(line)
}
