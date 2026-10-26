"use server"

import { auth } from "@clerk/nextjs/server"
import * as Sentry from "@sentry/nextjs"
import { and, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { db } from "@/db"
import { browserbaseClient } from "@/lib/browserbase"
import { customIntegrations, mcpServers } from "@/db/schema"
import { probeProviderById } from "@/lib/ai-health"
import {
  saveModelPreference,
  saveProviderSelection,
} from "@/lib/ai/provider-settings"
import { PROVIDER_IDS, type ProviderId } from "@/lib/ai/types"
import {
  AUTH_TYPES,
  INTEGRATION_CATEGORIES,
  probeEndpoint,
  type AuthType,
} from "@/lib/custom-integrations"
import { probeMcpServer } from "@/lib/mcp"
import { pcAgentSetup } from "@/lib/pc"
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/secrets"
import { assertPublicHttpUrl } from "@/lib/url-safety"
import {
  getConnectUrl,
  listAccounts,
  zernioPlatforms,
  type ZernioPlatform,
} from "@/lib/zernio"

function appUrl() {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
}

// Reads the accounts connected to this person's Zernio profile. It is called on
// demand from the Integrations page (never during render), so a slow or
// unconfigured provider cannot block the page.
export async function fetchSocialAccounts() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  try {
    const accounts = await listAccounts(userId)
    Sentry.logger.info("Social accounts listed", {
      "user.id": userId,
      "social.account_count": accounts.length,
    })

    return {
      error: null,
      accounts: accounts.map((account) => ({
        id: account._id,
        platform: account.platform,
        username: account.username,
        active: account.isActive,
      })),
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Zernio no respondió."
    Sentry.logger.warn("Social accounts failed", {
      "user.id": userId,
      error: message,
    })
    return { accounts: [], error: message }
  }
}

// The URL the person opens to authorize one network for their own profile. The
// agent cannot do this for them, and the key never reaches the browser.
export async function socialConnectUrl(platform: string) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")
  if (!zernioPlatforms.includes(platform as ZernioPlatform)) {
    throw new Error("Unknown social platform")
  }

  try {
    const url = await getConnectUrl(
      userId,
      platform as ZernioPlatform,
      `${appUrl()}/integrations`
    )

    Sentry.logger.info("Social connect link created", {
      "user.id": userId,
      "social.platform": platform,
    })

    return { url, error: null }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Zernio no respondió."
    return { url: null, error: message }
  }
}

// The token and command for the local PyAutoGUI module. It is the person's own
// credential, shown only to them, and it never appears in logs.
export async function pcAgentInstructions() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const setup = await pcAgentSetup(userId)
  return {
    token: setup.token,
    status: setup.status,
    command: setup.command.replace("<PC_AGENT_TOKEN>", setup.token).replace(
      "<APP_URL>",
      appUrl()
    ),
  }
}

// ---------------------------------------------------------------------------
// Integration centre
//
// Every action below: reads the session, validates its input, scopes every query
// by the session's user id, and returns a plain result instead of throwing — a
// stack trace is not an error message, and it can leak internals.
// ---------------------------------------------------------------------------

const authTypeSchema = z.enum(AUTH_TYPES)
const categorySchema = z.enum(INTEGRATION_CATEGORIES)

const customIntegrationSchema = z.object({
  name: z.string().trim().min(2, "Pon un nombre de al menos 2 caracteres.").max(60),
  category: categorySchema.default("other"),
  baseUrl: z.string().trim().min(1, "La URL es obligatoria.").max(500),
  authType: authTypeSchema.default("bearer"),
  // Empty means "keep what is stored" when editing, and "no credential" when
  // creating with authType "none".
  credential: z.string().trim().max(600).optional(),
  description: z.string().trim().max(300).optional(),
  capabilities: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
})

const mcpServerSchema = z.object({
  name: z.string().trim().min(2, "Pon un nombre de al menos 2 caracteres.").max(60),
  url: z.string().trim().min(1, "La URL es obligatoria.").max(500),
  authType: z.enum(["none", "bearer", "header"]).default("none"),
  credential: z.string().trim().max(600).optional(),
  enabled: z.boolean().default(true),
})

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Datos no válidos."
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value)
}

/** The person's provider order and opt-outs. Feeds the same router the chat uses. */
export async function saveProviderSelectionAction(input: {
  order: string[]
  disabled: string[]
}): Promise<{ ok: true; order: string[]; disabled: string[] } | { ok: false; error: string }> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) return { ok: false, error: "Inicia sesión." }

  const order = (Array.isArray(input.order) ? input.order : []).filter(isProviderId)
  const disabled = (Array.isArray(input.disabled) ? input.disabled : []).filter(isProviderId)

  if (order.length === 0) {
    return { ok: false, error: "Deja al menos un proveedor en el orden." }
  }

  try {
    const saved = await saveProviderSelection(userId, { order, disabled })
    revalidatePath("/settings/integrations")
    return { ok: true, order: saved.order, disabled: saved.disabled }
  } catch (error) {
    Sentry.logger.error("Provider selection not saved", {
      "user.id": userId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { ok: false, error: "No se pudo guardar la selección." }
  }
}

/**
 * Picks the model that leads one role, or clears it with `null`.
 *
 * The value arrives as `provider:modelId` because a model id can contain slashes
 * and colons. `saveModelPreference` re-validates it against the catalogue the
 * person has access to, so this action only parses.
 */
export async function saveRoleModelAction(
  role: string,
  value: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUser()
  if (!userId) return { ok: false, error: "Inicia sesión." }

  if (value === null || value === "") {
    const cleared = await saveModelPreference(userId, role, null)
    if (!cleared.ok) return cleared
    revalidatePath("/settings/integrations")
    return { ok: true }
  }

  const separator = value.indexOf(":")
  if (separator <= 0 || separator === value.length - 1) {
    return { ok: false, error: "Modelo no válido." }
  }

  const saved = await saveModelPreference(userId, role, {
    provider: value.slice(0, separator) as ProviderId,
    modelId: value.slice(separator + 1),
  })

  if (!saved.ok) return saved

  revalidatePath("/settings/integrations")
  Sentry.logger.info("Role model chosen", {
    "user.id": userId,
    "ai.role": role,
  })

  return { ok: true }
}

/** One real call to one provider, from the settings page. */
export async function testProviderAction(
  provider: string
): Promise<{ ok: boolean; status: string; model: string | null; ms: number; message: string }> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return { ok: false, status: "failed", model: null, ms: 0, message: "Inicia sesión." }
  }
  if (!isProviderId(provider)) {
    return { ok: false, status: "failed", model: null, ms: 0, message: "Proveedor desconocido." }
  }

  // The same probe the health endpoint uses: one model, one call, no router.
  const result = await probeProviderById(provider)

  Sentry.logger.info("Provider tested from settings", {
    "user.id": userId,
    "ai.provider": provider,
    "ai.probe_status": result.status,
  })

  return {
    ok: result.status === "ok",
    status: result.status,
    model: result.model,
    ms: result.ms,
    message:
      result.status === "ok"
        ? `Respondió en ${result.ms} ms.`
        : result.status === "skipped"
          ? (result.error ?? "No se pudo probar.")
          : (result.error ?? "Falló."),
  }
}

async function requireUser() {
  const { isAuthenticated, userId } = await auth()
  return isAuthenticated && userId ? userId : null
}

/** Saves a new custom API. The credential is encrypted before it touches the DB. */
export async function createCustomIntegrationAction(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUser()
  if (!userId) return { ok: false, error: "Inicia sesión." }

  const parsed = customIntegrationSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  const data = parsed.data

  try {
    await assertPublicHttpUrl(data.baseUrl)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "URL no válida." }
  }

  if (data.authType !== "none" && !data.credential) {
    return { ok: false, error: "Ese método de autenticación necesita una credencial." }
  }

  let ciphertext: string | null = null
  let hint: string | null = null
  if (data.credential && data.authType !== "none") {
    try {
      ciphertext = encryptSecret(data.credential)
      hint = maskSecret(data.credential)
    } catch (error) {
      // No plaintext fallback: the row is not written at all.
      return {
        ok: false,
        error: error instanceof Error ? error.message : "No se pudo cifrar la credencial.",
      }
    }
  }

  await db.insert(customIntegrations).values({
    userId,
    name: data.name,
    category: data.category,
    baseUrl: data.baseUrl,
    authType: data.authType,
    credentialCiphertext: ciphertext,
    credentialHint: hint,
    description: data.description ?? null,
    capabilities: data.capabilities,
    // Saved is not connected; only a successful probe moves this forward.
    status: "configured",
  })

  revalidatePath("/settings/integrations")
  Sentry.logger.info("Custom integration created", {
    "user.id": userId,
    "integration.category": data.category,
  })

  return { ok: true }
}

/** Edits a custom API. An empty credential keeps the stored one. */
export async function updateCustomIntegrationAction(
  id: string,
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUser()
  if (!userId) return { ok: false, error: "Inicia sesión." }

  const parsed = customIntegrationSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  const data = parsed.data

  const [existing] = await db
    .select()
    .from(customIntegrations)
    .where(and(eq(customIntegrations.id, id), eq(customIntegrations.userId, userId)))

  if (!existing) return { ok: false, error: "Esa integración no existe." }

  try {
    await assertPublicHttpUrl(data.baseUrl)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "URL no válida." }
  }

  let ciphertext = existing.credentialCiphertext
  let hint = existing.credentialHint

  if (data.authType === "none") {
    ciphertext = null
    hint = null
  } else if (data.credential) {
    try {
      ciphertext = encryptSecret(data.credential)
      hint = maskSecret(data.credential)
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "No se pudo cifrar la credencial.",
      }
    }
  } else if (!ciphertext) {
    return { ok: false, error: "Ese método de autenticación necesita una credencial." }
  }

  // The URL or the credential may have changed, so the previous verdict is gone.
  const connectionChanged =
    existing.baseUrl !== data.baseUrl ||
    existing.authType !== data.authType ||
    data.credential !== undefined

  await db
    .update(customIntegrations)
    .set({
      name: data.name,
      category: data.category,
      baseUrl: data.baseUrl,
      authType: data.authType,
      credentialCiphertext: ciphertext,
      credentialHint: hint,
      description: data.description ?? null,
      capabilities: data.capabilities,
      ...(connectionChanged && { status: "configured", lastError: null }),
      updatedAt: new Date(),
    })
    .where(and(eq(customIntegrations.id, id), eq(customIntegrations.userId, userId)))

  revalidatePath("/settings/integrations")
  return { ok: true }
}

export async function deleteCustomIntegrationAction(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUser()
  if (!userId) return { ok: false, error: "Inicia sesión." }

  const deleted = await db
    .delete(customIntegrations)
    .where(and(eq(customIntegrations.id, id), eq(customIntegrations.userId, userId)))
    .returning({ id: customIntegrations.id })

  if (deleted.length === 0) return { ok: false, error: "Esa integración no existe." }

  revalidatePath("/settings/integrations")
  return { ok: true }
}

/** Makes one real request with the stored credential and records the verdict. */
export async function testCustomIntegrationAction(
  id: string
): Promise<
  { ok: boolean; reachable: boolean; status: number | null; ms: number; message: string } | { ok: false; error: string }
> {
  const userId = await requireUser()
  if (!userId) return { ok: false, error: "Inicia sesión." }

  const [row] = await db
    .select()
    .from(customIntegrations)
    .where(and(eq(customIntegrations.id, id), eq(customIntegrations.userId, userId)))

  if (!row) return { ok: false, error: "Esa integración no existe." }

  let credential: string | null = null
  if (row.credentialCiphertext) {
    try {
      credential = decryptSecret(row.credentialCiphertext)
    } catch (error) {
      await db
        .update(customIntegrations)
        .set({
          status: "error",
          lastError: "No se pudo descifrar la credencial guardada.",
          lastCheckedAt: new Date(),
        })
        .where(eq(customIntegrations.id, id))
      return {
        ok: false,
        error: error instanceof Error ? error.message : "No se pudo descifrar la credencial.",
      }
    }
  }

  const outcome = await probeEndpoint({
    baseUrl: row.baseUrl,
    authType: row.authType as AuthType,
    credential,
  })

  await db
    .update(customIntegrations)
    .set({
      status: outcome.ok ? "verified" : outcome.reachable ? "configured" : "error",
      lastCheckedAt: new Date(),
      lastError: outcome.ok ? null : outcome.message,
      updatedAt: new Date(),
    })
    .where(and(eq(customIntegrations.id, id), eq(customIntegrations.userId, userId)))

  revalidatePath("/settings/integrations")

  Sentry.logger.info("Custom integration tested", {
    "user.id": userId,
    "integration.id": id,
    "integration.reachable": outcome.reachable,
    "integration.ok": outcome.ok,
  })

  return outcome
}

/** Saves an MCP endpoint. Nothing is reported as connected until it answers. */
export async function createMcpServerAction(
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUser()
  if (!userId) return { ok: false, error: "Inicia sesión." }

  const parsed = mcpServerSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  const data = parsed.data

  try {
    await assertPublicHttpUrl(data.url)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "URL no válida." }
  }

  let ciphertext: string | null = null
  let hint: string | null = null
  if (data.authType !== "none") {
    if (!data.credential) {
      return { ok: false, error: "Ese método de autenticación necesita una credencial." }
    }
    try {
      ciphertext = encryptSecret(data.credential)
      hint = maskSecret(data.credential)
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "No se pudo cifrar la credencial.",
      }
    }
  }

  await db.insert(mcpServers).values({
    userId,
    name: data.name,
    // Cloud only: a stdio server would mean running a command here.
    transport: "http",
    url: data.url,
    authType: data.authType,
    credentialCiphertext: ciphertext,
    credentialHint: hint,
    enabled: data.enabled,
    status: "unverified",
  })

  revalidatePath("/settings/integrations")
  return { ok: true }
}

export async function updateMcpServerAction(
  id: string,
  input: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUser()
  if (!userId) return { ok: false, error: "Inicia sesión." }

  const parsed = mcpServerSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  const data = parsed.data

  const [existing] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)))

  if (!existing) return { ok: false, error: "Ese servidor MCP no existe." }

  try {
    await assertPublicHttpUrl(data.url)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "URL no válida." }
  }

  let ciphertext = existing.credentialCiphertext
  let hint = existing.credentialHint

  if (data.authType === "none") {
    ciphertext = null
    hint = null
  } else if (data.credential) {
    try {
      ciphertext = encryptSecret(data.credential)
      hint = maskSecret(data.credential)
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "No se pudo cifrar la credencial.",
      }
    }
  } else if (!ciphertext) {
    return { ok: false, error: "Ese método de autenticación necesita una credencial." }
  }

  await db
    .update(mcpServers)
    .set({
      name: data.name,
      url: data.url,
      authType: data.authType,
      credentialCiphertext: ciphertext,
      credentialHint: hint,
      enabled: data.enabled,
      updatedAt: new Date(),
      // A changed endpoint invalidates what was discovered from the old one
      ...(existing.url !== data.url && {
        status: "unverified",
        tools: [],
        lastError: null,
      }),
    })
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)))

  revalidatePath("/settings/integrations")
  return { ok: true }
}

export async function deleteMcpServerAction(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUser()
  if (!userId) return { ok: false, error: "Inicia sesión." }

  const deleted = await db
    .delete(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)))
    .returning({ id: mcpServers.id })

  if (deleted.length === 0) return { ok: false, error: "Ese servidor MCP no existe." }

  revalidatePath("/settings/integrations")
  return { ok: true }
}

/** initialize + tools/list against the stored endpoint. Discovery, never a call. */
export async function testMcpServerAction(
  id: string
): Promise<
  | { ok: boolean; status: string; tools: { name: string; description?: string }[]; message: string }
  | { ok: false; error: string }
> {
  const userId = await requireUser()
  if (!userId) return { ok: false, error: "Inicia sesión." }

  const [row] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)))

  if (!row) return { ok: false, error: "Ese servidor MCP no existe." }

  let credential: string | null = null
  if (row.credentialCiphertext) {
    try {
      credential = decryptSecret(row.credentialCiphertext)
    } catch {
      await db
        .update(mcpServers)
        .set({
          status: "error",
          lastError: "No se pudo descifrar la credencial guardada.",
          lastCheckedAt: new Date(),
        })
        .where(eq(mcpServers.id, id))
      return { ok: false, error: "No se pudo descifrar la credencial guardada." }
    }
  }

  const result = await probeMcpServer({
    url: row.url,
    authType: row.authType as AuthType,
    credential,
  })

  await db
    .update(mcpServers)
    .set({
      status: result.status,
      tools: result.tools,
      lastCheckedAt: new Date(),
      lastError: result.ok ? null : result.message,
      updatedAt: new Date(),
    })
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)))

  revalidatePath("/settings/integrations")

  return {
    ok: result.ok,
    status: result.status,
    tools: result.tools,
    message: result.message,
  }
}

// ---------------------------------------------------------------------------
// Browserbase — a read-only check, never a session
// ---------------------------------------------------------------------------

/**
 * Verifies the Browserbase credentials with `sessions.list`, the cheapest call
 * that proves both the key and the project id. It creates nothing, so testing
 * never spends a browser session.
 */
export async function testBrowserbaseAction(): Promise<{
  ok: boolean
  message: string
}> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) return { ok: false, message: "Inicia sesión." }

  const missing = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"].filter(
    (name) => !process.env[name]?.trim()
  )
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Falta ${missing.join(" y ")} en el servidor. Se configura en el entorno del despliegue, no aquí.`,
    }
  }

  const started = Date.now()
  try {
    const client = browserbaseClient()
    // Bounded here instead of trusting an SDK default: a settings button must
    // never hang the page.
    await Promise.race([
      client.sessions.list({}, { maxRetries: 0 }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 8_000)
      ),
    ])

    Sentry.logger.info("Browserbase checked from settings", {
      "user.id": userId,
      "integration.ok": true,
    })

    return { ok: true, message: `Browserbase respondió en ${Date.now() - started} ms.` }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Browserbase no respondió."
    Sentry.logger.warn("Browserbase check failed", {
      "user.id": userId,
      error: message,
    })
    return {
      ok: false,
      message: message === "timeout" ? "Browserbase no respondió a tiempo." : message,
    }
  }
}
