import { assertPublicHttpUrl } from "@/lib/url-safety"

// One outbound HTTP call from a flow.
//
// The URL goes through the same guard the integration centre uses before any
// request leaves: https only, no embedded credentials, and every address the
// host resolves to must be public. A definition is untrusted input — a flow
// imported from somewhere else must not be able to point Paradox at
// localhost or the cloud metadata endpoint, which is exactly what
// assertPublicHttpUrl exists to refuse.
//
// The response body is truncated: a flow stores its step output, and a
// multi-megabyte payload in a run row helps nobody.

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
const TIMEOUT_MS = 20_000
const MAX_BODY_CHARS = 20_000

export async function httpRequest({
  url,
  method,
  body,
}: {
  url: string
  method?: string
  body?: string
}): Promise<{ status: number; ok: boolean; body: unknown }> {
  const target = (url ?? "").trim()
  if (!target) throw new Error("Falta la URL de la petición.")

  // The guard resolves the host here, on the server, before anything is sent.
  const safe = await assertPublicHttpUrl(target)

  const verb = (method ?? "GET").trim().toUpperCase() || "GET"
  if (!METHODS.has(verb)) {
    throw new Error(`Método HTTP no admitido: ${verb}`)
  }

  const text = (body ?? "").trim()
  const init: RequestInit = {
    method: verb,
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.8" },
  }

  if (text && verb !== "GET" && verb !== "HEAD") {
    // Sent verbatim: the person chooses whether it is JSON, form-encoded or
    // something else. A malformed body then fails as a 4xx from the API, which
    // is a clearer message than a silent re-encode here.
    init.body = text
    const headers = new Headers(init.headers)
    if (!headers.has("content-type")) headers.set("content-type", "application/json")
    init.headers = headers
  }

  const response = await fetch(safe.toString(), init)
  const raw = await response.text()
  const truncated =
    raw.length > MAX_BODY_CHARS ? `${raw.slice(0, MAX_BODY_CHARS)}…` : raw

  let parsed: unknown = truncated
  if (truncated) {
    try {
      parsed = JSON.parse(truncated)
    } catch {
      // Not JSON: the text is the answer.
    }
  }

  // A non-2xx is a failed step, not a successful one that happens to carry an
  // error: the run has to be able to retry or stop on it.
  if (!response.ok) {
    throw new Error(
      `La API respondió ${response.status} ${response.statusText}`.trim()
    )
  }

  return { status: response.status, ok: true, body: parsed }
}
