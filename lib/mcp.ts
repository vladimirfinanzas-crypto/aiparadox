import { credentialHeader, type AuthType } from "./custom-integrations"
import { assertPublicHttpUrl } from "./url-safety"

/**
 * MCP over streamable HTTP — the real handshake, not a saved URL.
 *
 * What this file does:
 *   1. `initialize` (JSON-RPC 2.0) and keeps the session id the server returns;
 *   2. `notifications/initialized`;
 *   3. `tools/list`, and reports exactly the tools the server answered with.
 *
 * What it deliberately does not do:
 *   - `stdio` transports. This app runs in the cloud; it never spawns a local
 *     command for a person, so a config that names one is rejected rather than
 *     half-honoured.
 *   - `tools/call`. Discovering a tool is not permission to run it, and the
 *     agent's tool registry is the only thing that may execute work.
 *
 * A server that does not answer is `status: "error"` with the reason. Nothing
 * here can turn a screenshot-of-a-URL into a "connected" badge.
 */

export type McpTool = { name: string; description?: string }

export type McpProbeResult = {
  ok: boolean
  status: "connected" | "error"
  serverName?: string
  protocolVersion?: string
  tools: McpTool[]
  message: string
}

/** The revision this client speaks; the server answers with its own choice. */
const PROTOCOL_VERSION = "2025-06-18"
const MAX_TOOLS = 200

function authHeaders(authType: AuthType, credential?: string | null) {
  return credential && authType !== "none"
    ? credentialHeader(authType, credential)
    : {}
}

type RpcOutcome = {
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
  sessionId?: string | null
  httpStatus: number
}

/** Reads a JSON-RPC answer that may arrive as JSON or as a single SSE event. */
async function readRpcResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? ""

  if (contentType.includes("text/event-stream")) {
    const text = await response.text()
    // Each event is "data: <json>"; the last one is the answer to this request.
    const payloads = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)

    for (const payload of payloads.reverse()) {
      try {
        return JSON.parse(payload)
      } catch {
        // Not JSON (an SSE comment or a keep-alive): keep looking
      }
    }
    return null
  }

  const text = await response.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function rpcCall(args: {
  url: URL
  headers: Record<string, string>
  body: Record<string, unknown>
  sessionId?: string | null
  signal: AbortSignal
}): Promise<RpcOutcome> {
  const response = await fetch(args.url, {
    method: "POST",
    redirect: "manual",
    signal: args.signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "Paradox/1.0 (+mcp-client)",
      ...args.headers,
      ...(args.sessionId ? { "mcp-session-id": args.sessionId } : {}),
    },
    body: JSON.stringify(args.body),
  })

  const sessionId = response.headers.get("mcp-session-id")
  const parsed = (await readRpcResponse(response)) as
    | { result?: Record<string, unknown>; error?: { code?: number; message?: string } }
    | null

  return {
    result: parsed?.result,
    error: parsed?.error,
    sessionId: sessionId ?? args.sessionId ?? null,
    httpStatus: response.status,
  }
}

function toolsFrom(result: Record<string, unknown> | undefined): McpTool[] {
  const raw = result?.tools
  if (!Array.isArray(raw)) return []

  return raw
    .slice(0, MAX_TOOLS)
    .map((entry): McpTool | null => {
      if (!entry || typeof entry !== "object") return null
      const record = entry as { name?: unknown; description?: unknown; title?: unknown }
      if (typeof record.name !== "string" || !record.name) return null
      const description =
        typeof record.description === "string"
          ? record.description
          : typeof record.title === "string"
            ? record.title
            : undefined
      return { name: record.name, ...(description && { description: description.slice(0, 300) }) }
    })
    .filter((entry): entry is McpTool => entry !== null)
}

/** Whether `initialize` + `tools/list` succeed against this endpoint. */
export async function probeMcpServer(input: {
  url: string
  authType: AuthType
  credential?: string | null
  timeoutMs?: number
}): Promise<McpProbeResult> {
  let url: URL
  try {
    url = await assertPublicHttpUrl(input.url)
  } catch (error) {
    return {
      ok: false,
      status: "error",
      tools: [],
      message: error instanceof Error ? error.message : "URL no válida.",
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000)
  const headers = authHeaders(input.authType, input.credential)

  try {
    const init = await rpcCall({
      url,
      headers,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "paradox", version: "1.0.0" },
        },
      },
      signal: controller.signal,
    })

    if (init.error) {
      return {
        ok: false,
        status: "error",
        tools: [],
        message: `El servidor rechazó initialize: ${init.error.message ?? "sin detalle"}.`,
      }
    }

    if (!init.result) {
      return {
        ok: false,
        status: "error",
        tools: [],
        message: `El endpoint no respondió a initialize (HTTP ${init.httpStatus}). ¿Es un servidor MCP?`,
      }
    }

    const serverInfo = init.result.serverInfo as { name?: unknown } | undefined
    const protocolVersion =
      typeof init.result.protocolVersion === "string"
        ? init.result.protocolVersion
        : PROTOCOL_VERSION

    // Required after initialize; servers may answer 202 with no body.
    await rpcCall({
      url,
      headers,
      sessionId: init.sessionId,
      signal: controller.signal,
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    }).catch(() => undefined)

    const list = await rpcCall({
      url,
      headers,
      sessionId: init.sessionId,
      signal: controller.signal,
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    })

    if (list.error) {
      return {
        ok: false,
        status: "error",
        serverName: typeof serverInfo?.name === "string" ? serverInfo.name : undefined,
        protocolVersion,
        tools: [],
        message: `El servidor respondió a initialize pero rechazó tools/list: ${list.error.message ?? "sin detalle"}.`,
      }
    }

    const tools = toolsFrom(list.result)

    return {
      ok: true,
      status: "connected",
      serverName: typeof serverInfo?.name === "string" ? serverInfo.name : undefined,
      protocolVersion,
      tools,
      message:
        tools.length > 0
          ? `Conectado. ${tools.length} herramienta${tools.length === 1 ? "" : "s"} publicada${tools.length === 1 ? "" : "s"}.`
          : "Conectado, pero el servidor no publicó ninguna herramienta.",
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError"
    return {
      ok: false,
      status: "error",
      tools: [],
      message: aborted
        ? "El servidor MCP no respondió a tiempo."
        : "No se pudo conectar con el servidor MCP (DNS, TLS o red).",
    }
  } finally {
    clearTimeout(timer)
  }
}
