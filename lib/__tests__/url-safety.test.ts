import { describe, expect, it } from "vitest"

import { UnsafeUrlError, assertPublicHttpUrl, isPrivateAddress } from "@/lib/url-safety"

// The server makes the request a person configures, so this guard is the line
// between "call my API" and "reach the cloud metadata endpoint".
//
// Resolution is injected: no test performs a DNS lookup.

const publicHost = async () => [{ address: "93.184.216.34" }]

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
  ])("blocks %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"])(
    "allows %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false)
    }
  )
})

describe("assertPublicHttpUrl", () => {
  it("accepts a public https URL", async () => {
    const url = await assertPublicHttpUrl("https://api.example.com/v1/ping", {
      resolve: publicHost,
    })
    expect(url.hostname).toBe("api.example.com")
  })

  it("accepts http, because some self-hosted APIs have no TLS", async () => {
    const url = await assertPublicHttpUrl("http://api.example.com/", {
      resolve: publicHost,
    })
    expect(url.protocol).toBe("http:")
  })

  it.each([
    ["file:///etc/passwd", /http/],
    ["ftp://example.com/", /http/],
    ["javascript:alert(1)", /http/],
  ])("rejects %s", async (raw, message) => {
    await expect(
      assertPublicHttpUrl(raw, { resolve: publicHost })
    ).rejects.toThrow(message)
  })

  it("rejects credentials embedded in the URL", async () => {
    await expect(
      assertPublicHttpUrl("https://user:pass@api.example.com/", { resolve: publicHost })
    ).rejects.toThrow(/credenciales/)
  })

  it.each(["http://localhost:3000/", "http://api.local/", "http://db.internal/"])(
    "rejects the internal host %s",
    async (raw) => {
      await expect(
        assertPublicHttpUrl(raw, { resolve: publicHost })
      ).rejects.toThrow(UnsafeUrlError)
    }
  )

  it("rejects a literal private address without any lookup", async () => {
    await expect(
      assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/", {
        resolve: async () => {
          throw new Error("must not be called")
        },
      })
    ).rejects.toThrow(/privada/)
  })

  it("rejects a public name that resolves to a private address", async () => {
    await expect(
      assertPublicHttpUrl("https://rebind.example.com/", {
        resolve: async () => [{ address: "10.0.0.5" }],
      })
    ).rejects.toThrow(/resuelve a una dirección privada/)
  })

  it("rejects when ANY resolved address is private", async () => {
    await expect(
      assertPublicHttpUrl("https://mixed.example.com/", {
        resolve: async () => [{ address: "93.184.216.34" }, { address: "192.168.0.10" }],
      })
    ).rejects.toThrow(/privada/)
  })

  it("reports a host that does not resolve", async () => {
    await expect(
      assertPublicHttpUrl("https://nope.example.com/", {
        resolve: async () => {
          throw new Error("ENOTFOUND")
        },
      })
    ).rejects.toThrow(/No se pudo resolver/)
  })

  it("rejects an empty value", async () => {
    await expect(assertPublicHttpUrl("   ")).rejects.toThrow(/vacía/)
  })
})
