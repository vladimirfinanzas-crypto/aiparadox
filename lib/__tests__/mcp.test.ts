import { afterEach, describe, expect, it, vi } from "vitest"

import { probeMcpServer } from "@/lib/mcp"

// The handshake, exercised against mocked HTTP. What is asserted is what the
// server actually answered: a URL alone must never become "connected".

const ENDPOINT = "https://93.184.216.34/mcp"

type Rpc = { id?: number; method: string }

function jsonRpc(handler: (call: Rpc) => unknown) {
  const fn = vi.fn(async (_url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Rpc
    return new Response(JSON.stringify(handler(body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("probeMcpServer", () => {
  it("completes initialize and lists the tools the server publishes", async () => {
    const fetchMock = jsonRpc((call) => {
      if (call.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: call.id,
          result: {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "demo-server" },
            capabilities: { tools: {} },
          },
        }
      }
      if (call.method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id: call.id,
          result: {
            tools: [
              { name: "search", description: "Busca documentos" },
              { name: "fetch" },
            ],
          },
        }
      }
      // notifications/initialized has no answer
      return { jsonrpc: "2.0", result: {} }
    })

    const result = await probeMcpServer({ url: ENDPOINT, authType: "none" })

    expect(result.ok).toBe(true)
    expect(result.status).toBe("connected")
    expect(result.serverName).toBe("demo-server")
    expect(result.tools.map((tool) => tool.name)).toEqual(["search", "fetch"])
    // initialize, notifications/initialized, tools/list — and no tools/call
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const methods = fetchMock.mock.calls.map(
      (call) => JSON.parse(String((call[1] as RequestInit).body)).method
    )
    expect(methods).not.toContain("tools/call")
  })

  it("reads an answer delivered as a single SSE event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Rpc
        const payload =
          body.method === "initialize"
            ? {
                jsonrpc: "2.0",
                id: body.id,
                result: { protocolVersion: "2025-06-18", serverInfo: { name: "sse" } },
              }
            : {
                jsonrpc: "2.0",
                id: body.id,
                result: { tools: [{ name: "ping" }] },
              }
        return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      })
    )

    const result = await probeMcpServer({ url: ENDPOINT, authType: "none" })
    expect(result.ok).toBe(true)
    expect(result.tools.map((tool) => tool.name)).toEqual(["ping"])
  })

  it("does not report connected when the endpoint is not an MCP server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>hola</html>", { status: 200 }))
    )

    const result = await probeMcpServer({ url: ENDPOINT, authType: "none" })

    expect(result.ok).toBe(false)
    expect(result.status).toBe("error")
    expect(result.tools).toEqual([])
    expect(result.message).toMatch(/¿Es un servidor MCP\?/)
  })

  it("reports the server's own rejection of initialize", async () => {
    jsonRpc((call) => ({
      jsonrpc: "2.0",
      id: call.id,
      error: { code: -32601, message: "method not found" },
    }))

    const result = await probeMcpServer({ url: ENDPOINT, authType: "none" })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/method not found/)
  })

  it("knows that initialize worked but tools/list did not", async () => {
    jsonRpc((call) =>
      call.method === "initialize"
        ? {
            jsonrpc: "2.0",
            id: call.id,
            result: { protocolVersion: "2025-06-18", serverInfo: { name: "half" } },
          }
        : { jsonrpc: "2.0", id: call.id, error: { message: "forbidden" } }
    )

    const result = await probeMcpServer({ url: ENDPOINT, authType: "none" })
    expect(result.ok).toBe(false)
    expect(result.serverName).toBe("half")
    expect(result.message).toMatch(/inicializó|respondió a initialize/)
  })

  it("is connected-but-empty when the server publishes no tools", async () => {
    jsonRpc((call) =>
      call.method === "initialize"
        ? { jsonrpc: "2.0", id: call.id, result: { protocolVersion: "2025-06-18" } }
        : { jsonrpc: "2.0", id: call.id, result: { tools: [] } }
    )

    const result = await probeMcpServer({ url: ENDPOINT, authType: "none" })
    expect(result.ok).toBe(true)
    expect(result.tools).toEqual([])
    expect(result.message).toMatch(/no publicó ninguna herramienta/)
  })

  it("reports a timeout instead of hanging the settings page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: URL, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const error = new Error("aborted")
              error.name = "AbortError"
              reject(error)
            })
          })
      )
    )

    const result = await probeMcpServer({ url: ENDPOINT, authType: "none", timeoutMs: 10 })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/no respondió a tiempo/)
  })

  it("refuses a private endpoint before any request", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const result = await probeMcpServer({
      url: "http://localhost:3333/mcp",
      authType: "none",
    })

    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends the stored credential as a header", async () => {
    const fetchMock = jsonRpc((call) => ({
      jsonrpc: "2.0",
      id: call.id,
      result: call.method === "initialize" ? {} : { tools: [] },
    }))

    await probeMcpServer({ url: ENDPOINT, authType: "bearer", credential: "tok-123" })

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit)
      .headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer tok-123")
  })
})
