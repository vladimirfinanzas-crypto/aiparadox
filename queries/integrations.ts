import { auth } from "@clerk/nextjs/server"
import { desc, eq } from "drizzle-orm"

import { db } from "@/db"
import { customIntegrations, mcpServers } from "@/db/schema"
import {
  getModelPreferences,
  readProviderSelection,
} from "@/lib/ai/provider-settings"
import { disabledProviders } from "@/lib/ai/models"
import { providerConfigurations } from "@/lib/ai/provider-registry"
import { getOrCreateIntegration } from "@/lib/pc"
import { encryptionAvailable } from "@/lib/secrets"

export type ServiceId =
  | "openrouter"
  | "browserbase"
  | "zernio"
  | "trigger"
  | "sentry"
  | "database"
  | "clerk"
  | "resend"

export type EnvironmentStatus = Record<ServiceId, boolean>

// Which secrets the server can see, as booleans only. The values never leave
// the server and are never rendered, logged or sent to the client.
export function getEnvironmentStatus(): EnvironmentStatus {
  const has = (value: string | undefined) =>
    Boolean(value && value.trim().length > 0)

  return {
    openrouter: has(process.env.OPENROUTER_API_KEY),
    browserbase:
      has(process.env.BROWSERBASE_API_KEY) &&
      has(process.env.BROWSERBASE_PROJECT_ID),
    zernio: has(process.env.ZERNIO_API_KEY),
    trigger: has(process.env.TRIGGER_SECRET_KEY),
    sentry: has(process.env.NEXT_PUBLIC_SENTRY_DSN),
    database: has(process.env.DATABASE_URL),
    clerk: has(process.env.CLERK_SECRET_KEY),
    resend: has(process.env.RESEND_API_KEY),
  }
}

// This person's integration row: the Zernio profile and the token their local
// PyAutoGUI agent authenticates with. Created on demand so the settings page
// always has something to show.
export async function getMyIntegration() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const integration = await getOrCreateIntegration(userId)
  return { userId, integration }
}

// ---------------------------------------------------------------------------
// Integration centre
// ---------------------------------------------------------------------------

/**
 * Everything Settings → Integrations renders, already scoped to the session and
 * already free of secrets.
 *
 * Provider data comes from the same registry the router uses
 * (`providerConfigurations`), so the page can never disagree with what the model
 * layer believes. Stored credentials are selected as a masked hint only; the
 * ciphertext never leaves the server.
 */
export type IntegrationCenter = Awaited<ReturnType<typeof getIntegrationCenter>>

export async function getIntegrationCenter() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const [selectionRead, preferences, customRows, mcpRows] = await Promise.all([
    readProviderSelection(userId),
    getModelPreferences(userId),
    db
      .select({
        id: customIntegrations.id,
        name: customIntegrations.name,
        category: customIntegrations.category,
        baseUrl: customIntegrations.baseUrl,
        authType: customIntegrations.authType,
        credentialHint: customIntegrations.credentialHint,
        description: customIntegrations.description,
        capabilities: customIntegrations.capabilities,
        status: customIntegrations.status,
        lastCheckedAt: customIntegrations.lastCheckedAt,
        lastError: customIntegrations.lastError,
        createdAt: customIntegrations.createdAt,
      })
      .from(customIntegrations)
      .where(eq(customIntegrations.userId, userId))
      .orderBy(desc(customIntegrations.createdAt)),
    db
      .select({
        id: mcpServers.id,
        name: mcpServers.name,
        transport: mcpServers.transport,
        url: mcpServers.url,
        authType: mcpServers.authType,
        credentialHint: mcpServers.credentialHint,
        enabled: mcpServers.enabled,
        tools: mcpServers.tools,
        status: mcpServers.status,
        lastCheckedAt: mcpServers.lastCheckedAt,
        lastError: mcpServers.lastError,
        createdAt: mcpServers.createdAt,
      })
      .from(mcpServers)
      .where(eq(mcpServers.userId, userId))
      .orderBy(desc(mcpServers.createdAt)),
  ])

  return {
    providers: providerConfigurations(),
    selection: selectionRead.selection,
    /**
     * False until drizzle/0007 and 0008 are applied. The page says so instead of
     * presenting the environment defaults as this person's own settings.
     */
    tablesReady: selectionRead.tablesReady,
    // The model each person chose to lead a role, already filtered to models
    // that still exist in the catalogue.
    preferences,
    // Providers the operator switched off on the server. The UI shows them as
    // locked instead of offering a toggle that could never take effect.
    environmentDisabled: [...disabledProviders()],
    custom: customRows,
    mcp: mcpRows,
    encryptionAvailable: encryptionAvailable(),
    environment: getEnvironmentStatus(),
  }
}
