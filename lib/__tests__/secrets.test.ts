import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  ENCRYPTION_KEY_ENV,
  SecretsNotConfiguredError,
  decryptSecret,
  encryptSecret,
  encryptionAvailable,
  generateEncryptionKey,
  maskSecret,
} from "@/lib/secrets"

// Credentials at rest. The interesting cases are the failures: no key, a wrong
// key, a modified payload.

const original = process.env[ENCRYPTION_KEY_ENV]

beforeEach(() => {
  process.env[ENCRYPTION_KEY_ENV] = generateEncryptionKey()
})

afterEach(() => {
  if (original === undefined) delete process.env[ENCRYPTION_KEY_ENV]
  else process.env[ENCRYPTION_KEY_ENV] = original
})

describe("secret encryption", () => {
  it("round-trips a credential", () => {
    const secret = "sk-live-abcdef123456"
    expect(decryptSecret(encryptSecret(secret))).toBe(secret)
  })

  it("never produces the same ciphertext twice", () => {
    const secret = "same-value"
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret))
  })

  it("stores nothing in clear text", () => {
    const ciphertext = encryptSecret("sk-live-abcdef123456")
    expect(ciphertext).not.toContain("sk-live")
    expect(ciphertext.startsWith("v1.")).toBe(true)
  })

  it("accepts a hex key as well as base64", () => {
    process.env[ENCRYPTION_KEY_ENV] = Buffer.alloc(32, 7).toString("hex")
    expect(decryptSecret(encryptSecret("value"))).toBe("value")
  })

  it("refuses to encrypt without a key instead of falling back to plaintext", () => {
    delete process.env[ENCRYPTION_KEY_ENV]
    expect(() => encryptSecret("value")).toThrow(SecretsNotConfiguredError)
    expect(encryptionAvailable()).toBe(false)
  })

  it("rejects a key of the wrong length", () => {
    process.env[ENCRYPTION_KEY_ENV] = Buffer.alloc(16, 1).toString("base64")
    expect(encryptionAvailable()).toBe(false)
    expect(() => encryptSecret("value")).toThrow(/32 bytes/)
  })

  it("detects a payload encrypted with another key", () => {
    const ciphertext = encryptSecret("value")
    process.env[ENCRYPTION_KEY_ENV] = generateEncryptionKey()
    expect(() => decryptSecret(ciphertext)).toThrow(/could not be decrypted/)
  })

  it("detects a modified payload", () => {
    const parts = encryptSecret("value").split(".")
    const flipped = Buffer.from(parts[3] ?? "", "base64")
    flipped[0] = (flipped[0] ?? 0) ^ 0xff
    parts[3] = flipped.toString("base64")
    expect(() => decryptSecret(parts.join("."))).toThrow(/could not be decrypted/)
  })

  it("rejects an unknown format", () => {
    expect(() => decryptSecret("plain-text-token")).toThrow(/unknown format/)
  })

  it("masks everything but the last four characters", () => {
    expect(maskSecret("sk-live-abcdef123456")).toBe("••••3456")
    expect(maskSecret("abc")).toBe("••••")
  })
})
