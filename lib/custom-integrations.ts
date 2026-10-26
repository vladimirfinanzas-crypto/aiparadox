import { assertPublicHttpUrl } from "./url-safety"

/**
 * A custom API a person added: how its credential is presented, and what a real
 * request to it proves.
 *
 * There is no "assume it works": `probe` performs the request and reports what
 * came back. `reachable` and `authenticated` are separate facts, because a 401
 * means the URL is right and the key is not, which is the difference between
 * editing a field and checking a dashboard.
 */

export const AUTH_TYPES = ["bearer", "header", "basic", "none"] as const
export type AuthType = (typeof AUTH_TYPES)[number]

export const INTEGRATION_CATEGORIES = [
  "ai",
  "automation",
  "api",
  "communication",
  "social",
  "other",
] as const
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number]

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  ai: "Proveedores de IA",
  automation: "Navegadores y automatización",
  api: "APIs externas",
  communication: "Comunicación y correo",
  social: "Redes sociales",
  other: "Otras herramientas",
}

export type ProbeOutcome = {
  /** The host answered at all (any HTTP status below 500 counts). */
  reachable: boolean
  /** The answer was a success status, so the credential (if any) was accepted. */
  ok: boolean
  status: number | null
  ms: number
  /** Safe, human sentence. Never contains the credential. */
  message: string
}

/**
 * Query-string auth is rejected on purpose: a key in the URL ends up in proxy
 * logs, browser history and error messages. Bearer, header and basic keep it in
 * a header.
 */
export function credentialHeader(
  authType: AuthType,
  credential: string
): Record<string, string> {
  switch (authType) {
    case "bearer":
      return { authorization: `Bearer ${credential}` }
    case "header":
      return { "x-api-key": credential }
    case "basic":
      // "user:password", as every HTTP client expects for Basic
      return {
        authorization: `Basic ${Buffer.from(credential, "utf8").toString("base64")}`,
      }
    case "none":
    default:
      return {}
  }
}

function describeStatus(status: number): string {
  if (status >= 200 && status < 300) return `respondió ${status}.`
  if (status === 401 || status === 403) {
    return `respondió ${status}: el host es correcto pero la credencial fue rechazada.`
  }
  if (status === 404) {
    return "respondió 404: el host existe pero esa ruta no."
  }
  if (status === 429) return "respondió 429: límite de peticiones del servicio."
  if (status >= 500) return `respondió ${status}: el servicio está fallando.`
  return `respondió ${status}.`
}

/**
 * Sends one request to the endpoint.
 *
 * GET, not HEAD: many APIs answer 405 to HEAD and that would look like a broken
 * integration. `redirect: "manual"` keeps the request on the URL that was
 * validated — following a redirect would let the target bounce the server
 * somewhere private after the SSRF check.
 */
export async function probeEndpoint(input: {
  baseUrl: string
  authType: AuthType
  credential?: string | null
  timeoutMs?: number
}): Promise<ProbeOutcome> {
  const started = Date.now()

  let url: URL
  try {
    url = await assertPublicHttpUrl(input.baseUrl)
  } catch (error) {
    return {
      reachable: false,
      ok: false,
      status: null,
      ms: Date.now() - started,
      message: error instanceof Error ? error.message : "URL no válida.",
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 8_000)

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        "user-agent": "Paradox/1.0 (+integration-check)",
        ...(input.credential && input.authType !== "none"
          ? credentialHeader(input.authType, input.credential)
          : {}),
      },
    })

    const ms = Date.now() - started
    const status = response.status

    return {
      reachable: status < 500,
      ok: status >= 200 && status < 300,
      status,
      ms,
      message: describeStatus(status),
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError"
    return {
      reachable: false,
      ok: false,
      status: null,
      ms: Date.now() - started,
      message: aborted
        ? "El servicio no respondió a tiempo."
        : "No se pudo conectar con el servicio (DNS, TLS o red).",
    }
  } finally {
    clearTimeout(timer)
  }
}
