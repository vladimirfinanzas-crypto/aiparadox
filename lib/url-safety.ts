import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

/**
 * Guard for every URL a person types into the integration centre.
 *
 * The server makes the request, so a URL is an instruction to it. Without this
 * check, "https://internal-host/" or "http://169.254.169.254/" would let a
 * signed-in account use Paradox to reach its own network or the cloud metadata
 * endpoint. The rules are deliberately blunt:
 *
 *   - http(s) only;
 *   - no credentials embedded in the URL (`user:pass@host`);
 *   - the host must resolve, and EVERY address it resolves to must be public.
 *
 * Resolution happens on the server, once, and the answer is what gets used: a
 * hostname that resolves differently on a second lookup (DNS rebinding) does not
 * help an attacker here because the request is issued immediately after.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeUrlError"
  }
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return null
  }
  return parts
}

/** Loopback, private, link-local, CGNAT, multicast, reserved. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)

  if (family === 4) {
    const parts = ipv4Parts(address)
    if (!parts) return true
    const [a = 0, b = 0] = parts

    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 192 && b === 0) return true
    if (a >= 224) return true // multicast + reserved
    return false
  }

  if (family === 6) {
    const normalized = address.toLowerCase()
    if (normalized === "::" || normalized === "::1") return true
    if (normalized.startsWith("fe80")) return true // link-local
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true // ULA
    if (normalized.startsWith("::ffff:")) {
      // IPv4-mapped: re-check the IPv4 part
      const mapped = normalized.slice("::ffff:".length)
      return isPrivateAddress(mapped)
    }
    if (normalized.startsWith("ff")) return true // multicast
    return false
  }

  return true
}

type Resolver = (host: string) => Promise<{ address: string }[]>

const defaultResolver: Resolver = async (host) => lookup(host, { all: true })

/**
 * Parses and validates a user-supplied URL, returning the URL to use.
 *
 * @throws UnsafeUrlError with a message that says what is wrong (and never
 *         includes any credential).
 */
export async function assertPublicHttpUrl(
  raw: string,
  options: { resolve?: Resolver } = {}
): Promise<URL> {
  const trimmed = raw.trim()
  if (!trimmed) throw new UnsafeUrlError("La URL está vacía.")

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new UnsafeUrlError("La URL no es válida (se esperaba https://…).")
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError("Solo se admiten URLs http:// o https://.")
  }

  if (url.username || url.password) {
    throw new UnsafeUrlError(
      "No pongas credenciales en la URL: se guardan cifradas en el campo de credencial."
    )
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  if (!hostname) throw new UnsafeUrlError("La URL no tiene host.")

  const lowered = hostname.toLowerCase()
  if (
    lowered === "localhost" ||
    lowered.endsWith(".localhost") ||
    lowered.endsWith(".local") ||
    lowered.endsWith(".internal")
  ) {
    throw new UnsafeUrlError(
      "Ese host es interno (localhost/.local/.internal): el servidor no hace peticiones a la red local."
    )
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new UnsafeUrlError(
        "Esa dirección es privada o reservada: el servidor no hace peticiones a la red local."
      )
    }
    return url
  }

  const resolve = options.resolve ?? defaultResolver
  let addresses: { address: string }[]
  try {
    addresses = await resolve(hostname)
  } catch {
    throw new UnsafeUrlError(`No se pudo resolver el host «${hostname}».`)
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError(`El host «${hostname}» no resuelve a ninguna dirección.`)
  }

  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new UnsafeUrlError(
      "El host resuelve a una dirección privada o reservada: el servidor no hace peticiones a la red local."
    )
  }

  return url
}
