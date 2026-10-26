import { afterEach, describe, expect, it, vi } from "vitest"

import { credentialHeader, probeEndpoint } from "@/lib/custom-integrations"

// One real request, described honestly. The URLs are literal public addresses so
// no test performs a DNS lookup.

// 93.184.216.34 is a public address, so the SSRF guard lets it through without
// resolving anything.
const ENDPOINT = "https://93.184.216.34/v1/ping"

function mockFetch(impl: (url: URL, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal("fetch", fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("credentialHeader", () => {
  it("keeps the credential in a header, never in the URL", () => {
    expect(credentialHeader("bearer", "sk-1")).toEqual({ authorization: "Bearer sk-1" })
    expect(credentialHeader("header", "sk-2")).toEqual({ "x-api-key": "sk-2" })
    expect(credentialHeader("basic", "user:pass")).toEqual({
      authorization: `Basic ${Buffer.from("user:pass").toString("base64")}`,
    })
    expect(credentialHeader("none", "ignored")).toEqual({})
  })
})

describe("probeEndpoint", () => {
  it("reports success only for a 2xx answer", async () => {
    mockFetch(async () => new Response("{}", { status: 200 }))

    const outcome = await probeEndpoint({
      baseUrl: ENDPOINT,
      authType: "bearer",
      credential: "sk-test",
    })

    expect(outcome).toMatchObject({ ok: true, reachable: true, status: 200 })
  })

  it("separates a rejected credential from an unreachable host", async () => {
    mockFetch(async () => new Response("nope", { status: 401 }))

    const outcome = await probeEndpoint({
      baseUrl: ENDPOINT,
      authType: "bearer",
      credential: "wrong",
    })

    expect(outcome.ok).toBe(false)
    // The host answered: the credential is wrong, not the URL.
    expect(outcome.reachable).toBe(true)
    expect(outcome.status).toBe(401)
    expect(outcome.message).toMatch(/credencial fue rechazada/)
  })

  it("treats a 5xx as the service failing, not the credential", async () => {
    mockFetch(async () => new Response("boom", { status: 503 }))
    const outcome = await probeEndpoint({ baseUrl: ENDPOINT, authType: "none" })
    expect(outcome).toMatchObject({ ok: false, reachable: false, status: 503 })
  })

  it("reports a 404 as a wrong path", async () => {
    mockFetch(async () => new Response("", { status: 404 }))
    const outcome = await probeEndpoint({ baseUrl: ENDPOINT, authType: "none" })
    expect(outcome.reachable).toBe(true)
    expect(outcome.message).toMatch(/esa ruta no/)
  })

  it("reports a network failure without inventing a status", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed")
    })
    const outcome = await probeEndpoint({ baseUrl: ENDPOINT, authType: "none" })
    expect(outcome).toMatchObject({ ok: false, reachable: false, status: null })
    expect(outcome.message).toMatch(/No se pudo conectar/)
  })

  it("reports a timeout", async () => {
    mockFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted")
            error.name = "AbortError"
            reject(error)
          })
        })
    )

    const outcome = await probeEndpoint({
      baseUrl: ENDPOINT,
      authType: "none",
      timeoutMs: 10,
    })

    expect(outcome.message).toMatch(/no respondió a tiempo/)
  })

  it("never follows a redirect away from the validated URL", async () => {
    const fetchMock = mockFetch(async () => new Response(null, { status: 302 }))

    await probeEndpoint({ baseUrl: ENDPOINT, authType: "none" })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).redirect).toBe("manual")
  })

  it("sends the credential as a header and never in the URL", async () => {
    const fetchMock = mockFetch(async () => new Response("{}", { status: 200 }))

    await probeEndpoint({ baseUrl: ENDPOINT, authType: "bearer", credential: "sk-1" })

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(String(url)).not.toContain("sk-1")
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-1")
  })

  it("refuses a private host before doing any request", async () => {
    const fetchMock = mockFetch(async () => new Response("{}", { status: 200 }))

    const outcome = await probeEndpoint({
      baseUrl: "http://169.254.169.254/latest/meta-data/",
      authType: "none",
    })

    expect(outcome.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
