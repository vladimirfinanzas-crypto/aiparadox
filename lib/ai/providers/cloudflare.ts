import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

import type { ProviderAdapter } from "../types"

const ACCOUNT = "CLOUDFLARE_ACCOUNT_ID"
const TOKEN = "CLOUDFLARE_API_TOKEN"

function accountId(): string | null {
  const value = process.env[ACCOUNT]?.trim()
  return value ? value : null
}

function apiToken(): string | null {
  const value = process.env[TOKEN]?.trim()
  return value ? value : null
}

/**
 * Workers AI streams a generated number as a JSON number, not a string: a chunk
 * can arrive as `{"delta":{"content":1}}`. The OpenAI-compatible schema requires
 * a string and rejects the whole stream with a type validation error, so tokens
 * are coerced back to strings here. Only numeric content is touched; tool calls,
 * usage and error frames pass through unchanged.
 */
export function fixCloudflareSseLine(line: string): string {
  if (!line.startsWith("data:")) return line
  const payload = line.slice(5).trim()
  if (!payload || payload === "[DONE]") return line

  try {
    const parsed = JSON.parse(payload) as {
      choices?: { delta?: { content?: unknown } }[]
    }
    let changed = false
    for (const choice of parsed.choices ?? []) {
      const content = choice?.delta?.content
      if (typeof content === "number") {
        choice.delta!.content = String(content)
        changed = true
      }
    }
    return changed ? `data: ${JSON.stringify(parsed)}` : line
  } catch {
    // Not JSON, or not a shape we understand: leave the frame alone.
    return line
  }
}

function sanitizeEventStream(response: Response): Response {
  if (!response.body) return response

  let buffer = ""
  const lines = new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk
      const parts = buffer.split("\n")
      buffer = parts.pop() ?? ""
      for (const line of parts) controller.enqueue(`${fixCloudflareSseLine(line)}\n`)
    },
    flush(controller) {
      if (buffer) controller.enqueue(fixCloudflareSseLine(buffer))
    },
  })

  const headers = new Headers(response.headers)
  // The body is re-encoded, so the original length/encoding no longer applies.
  headers.delete("content-length")
  headers.delete("content-encoding")

  const body = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(lines)
    .pipeThrough(new TextEncoderStream())

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const cloudflareFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  const contentType = response.headers.get("content-type") ?? ""
  return contentType.includes("text/event-stream")
    ? sanitizeEventStream(response)
    : response
}

/**
 * Cloudflare Workers AI, through its OpenAI-compatible chat endpoint:
 * `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`.
 *
 * The token needs Workers AI: Read (Workers AI: Edit if the same token is used
 * to deploy Workers). A legacy Global API Key with the account email is not used
 * here: scoped tokens are the documented, least-privilege method.
 *
 * Its free allocation is 10,000 Neurons per day, resetting at 00:00 UTC, and a
 * Neuron is a unit of compute — not a request. Cloudflare returns 429 code 3036
 * when the daily allocation is spent and 3040 when capacity is momentarily
 * exceeded; the classifier separates the two so a busy minute does not disable
 * the provider for the rest of the day.
 *
 * This provider is the last resort in the routing order and is preferred for
 * lightweight auxiliary work, because a chat turn with a long toolbelt burns
 * Neurons faster than the smaller providers' request quotas run out.
 */
export const cloudflare: ProviderAdapter = {
  id: "cloudflare",
  label: "Cloudflare Workers AI",
  requires: [ACCOUNT, TOKEN],
  quotaUnit: "neurons",
  note: "Last resort. 10,000 free Neurons/day (compute, not requests); resets 00:00 UTC.",

  isConfigured: () => accountId() !== null && apiToken() !== null,

  missingEnv: () => [
    ...(accountId() ? [] : [ACCOUNT]),
    ...(apiToken() ? [] : [TOKEN]),
  ],

  createModel: (modelId) => {
    const account = accountId()
    if (!account) throw new Error(`${ACCOUNT} is not set`)

    const provider = createOpenAICompatible({
      name: "cloudflare-workers-ai",
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`,
      apiKey: apiToken() ?? "",
      // Streams carry a final usage chunk (including Neurons), which the quota
      // manager records, and numeric content chunks are repaired.
      includeUsage: true,
      fetch: cloudflareFetch,
    })

    return provider(modelId)
  },
}
