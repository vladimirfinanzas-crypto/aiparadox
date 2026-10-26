import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/**
 * Encryption for the credentials a person stores in the integration centre.
 *
 * AES-256-GCM with a random IV per value, so the same token encrypts to a
 * different ciphertext every time and tampering is detected on decrypt. The key
 * is `INTEGRATIONS_ENCRYPTION_KEY` (32 bytes, base64 or hex) and lives only in
 * the server's environment — never in the database, the client bundle or a log.
 *
 * There is deliberately no fallback: without the key, `encryptSecret` throws and
 * the action refuses to save. Storing a credential in clear text because a
 * variable was missing is exactly the failure this module exists to prevent.
 *
 * Generate a key with:  openssl rand -base64 32
 */

export const ENCRYPTION_KEY_ENV = "INTEGRATIONS_ENCRYPTION_KEY"

/** 32 bytes, ready to paste into a deployment's environment. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString("base64")
}

export class SecretsNotConfiguredError extends Error {
  constructor(reason: string) {
    super(
      `${ENCRYPTION_KEY_ENV} is not usable: ${reason}. Credentials are only stored encrypted, so nothing was saved. Generate a key with \`openssl rand -base64 32\` and set it in the deployment's environment.`
    )
    this.name = "SecretsNotConfiguredError"
  }
}

function key(): Buffer {
  const raw = process.env[ENCRYPTION_KEY_ENV]?.trim()
  if (!raw) throw new SecretsNotConfiguredError("the variable is not set")

  const decoded = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64")

  if (decoded.length !== 32) {
    throw new SecretsNotConfiguredError(
      `it must decode to 32 bytes (got ${decoded.length})`
    )
  }

  return decoded
}

/** Whether credentials can be stored at all, for the UI to say so up front. */
export function encryptionAvailable(): boolean {
  try {
    key()
    return true
  } catch {
    return false
  }
}

const VERSION = "v1"

/**
 * `v1.<iv>.<tag>.<ciphertext>`, each part base64. The version prefix is there so
 * a future algorithm change can be detected instead of silently mis-decrypted.
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) throw new Error("There is nothing to encrypt.")

  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".")
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(".")
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Stored credential has an unknown format.")
  }

  const iv = Buffer.from(parts[1] ?? "", "base64")
  const tag = Buffer.from(parts[2] ?? "", "base64")
  const ciphertext = Buffer.from(parts[3] ?? "", "base64")

  const decipher = createDecipheriv("aes-256-gcm", key(), iv)
  decipher.setAuthTag(tag)

  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8")
  } catch {
    // A wrong key or a modified ciphertext both land here. Never echo the input.
    throw new Error(
      "Stored credential could not be decrypted (wrong key or modified data)."
    )
  }
}

/**
 * What the UI may show after saving: enough to recognise the key, not enough to
 * use it. Short values are masked completely.
 */
export function maskSecret(plaintext: string): string {
  const trimmed = plaintext.trim()
  if (trimmed.length <= 4) return "••••"
  return `••••${trimmed.slice(-4)}`
}
