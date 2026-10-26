import { and, asc, eq } from "drizzle-orm"

import { db } from "@/db"
import { aiModelPreferences, aiProviderSettings } from "@/db/schema"

import { catalogCandidateFor, disabledProviders, providerOrder } from "./models"
import {
  MODEL_ROLES,
  PROVIDER_IDS,
  type ModelRole,
  type ProviderId,
} from "./types"
import type { RoleModelPreference } from "./models"

/**
 * Which AI providers one person enabled, and in what order.
 *
 * This is a *selection* on top of the operator's configuration, not a second
 * system: the router reads it through `catalogForRole(role, selection)`, the
 * same function that reads `PARADOX_PROVIDER_ORDER`. Precedence is deliberate —
 *
 *   - a provider the operator disabled in the environment stays disabled, no
 *     matter what a person saved (it is a server decision, and its key may not
 *     even be present);
 *   - a provider the person disabled is skipped for their turns only;
 *   - the order is theirs when they saved one, otherwise the environment's.
 *
 * A provider with no credentials is still skipped later by the router, so an
 * enabled-but-unkeyed provider simply never answers.
 */
export type ResolvedProviderSelection = {
  order: ProviderId[]
  disabled: ProviderId[]
}

const KNOWN = new Set<string>(PROVIDER_IDS)

function knownOnly(ids: readonly string[]): ProviderId[] {
  return ids.filter((id): id is ProviderId => KNOWN.has(id))
}

/** What applies when the person never opened the integration centre. */
export function defaultSelection(): ResolvedProviderSelection {
  return {
    order: providerOrder(),
    disabled: [...disabledProviders()],
  }
}

/**
 * Postgres `undefined_table`, raised while the integration-centre migrations have
 * not been applied to a database yet.
 *
 * It must not take the chat down: the readers fall back to the environment's
 * behaviour and say why in the logs. The writers do not catch it — a save that did
 * not happen must fail out loud rather than report success.
 */
function isMissingTable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "42P01"
}

/**
 * The person's selection, already merged with the environment's rules, plus
 * whether the tables it lives in exist yet.
 */
export async function readProviderSelection(
  userId: string
): Promise<{ selection: ResolvedProviderSelection; tablesReady: boolean }> {
  let rows: { provider: string; enabled: boolean; position: number }[]

  try {
    rows = await db
      .select({
        provider: aiProviderSettings.provider,
        enabled: aiProviderSettings.enabled,
        position: aiProviderSettings.position,
      })
      .from(aiProviderSettings)
      .where(eq(aiProviderSettings.userId, userId))
      .orderBy(asc(aiProviderSettings.position))
  } catch (error) {
    if (!isMissingTable(error)) throw error
    console.warn(
      "[provider-settings] ai_provider_settings does not exist yet; using the environment defaults. Apply drizzle/0007_integration_center.sql."
    )
    return { selection: defaultSelection(), tablesReady: false }
  }

  const envDisabled = disabledProviders()

  if (rows.length === 0) {
    return { selection: defaultSelection(), tablesReady: true }
  }

  const ordered = knownOnly(rows.map((row) => row.provider))
  const chosenDisabled = knownOnly(
    rows.filter((row) => !row.enabled).map((row) => row.provider)
  )

  // Providers added to the product after this person saved keep their place at
  // the end instead of disappearing from their routing.
  const rest = providerOrder().filter((id) => !ordered.includes(id))

  return {
    selection: {
      order: [...ordered, ...rest],
      disabled: [...new Set([...envDisabled, ...chosenDisabled])],
    },
    tablesReady: true,
  }
}

/**
 * The person's selection, already merged with the environment's rules.
 *
 * Rows are only written when someone saves, so an untouched account does no
 * query work beyond one empty read.
 */
export async function getProviderSelection(
  userId: string
): Promise<ResolvedProviderSelection> {
  return (await readProviderSelection(userId)).selection
}

/**
 * Replaces the person's selection. Validates against the catalogue so an unknown
 * id can never be persisted and later confuse the router.
 */
export async function saveProviderSelection(
  userId: string,
  selection: ResolvedProviderSelection
): Promise<ResolvedProviderSelection> {
  const order = knownOnly(selection.order)
  const disabled = new Set(knownOnly(selection.disabled))

  // Anything the caller omitted is appended, so saving never drops a provider
  const complete = [
    ...order,
    ...PROVIDER_IDS.filter((id) => !order.includes(id)),
  ]

  await db.transaction(async (tx) => {
    await tx
      .delete(aiProviderSettings)
      .where(eq(aiProviderSettings.userId, userId))

    await tx.insert(aiProviderSettings).values(
      complete.map((provider, index) => ({
        userId,
        provider,
        enabled: !disabled.has(provider),
        position: index,
        updatedAt: new Date(),
      }))
    )
  })

  return getProviderSelection(userId)
}

// ---------------------------------------------------------------------------
// Which model leads each role
// ---------------------------------------------------------------------------

const ROLES = new Set<string>(MODEL_ROLES)

/**
 * The person's per-role choices, already filtered to models that still exist.
 *
 * Filtering here (not at the call site) means a preference cannot outlive its
 * catalogue entry: if a provider drops a model, that role silently returns to
 * the normal ladder instead of failing every call.
 */
export async function getModelPreferences(
  userId: string
): Promise<Partial<Record<ModelRole, RoleModelPreference>>> {
  let rows: { role: string; provider: string; modelId: string }[]

  try {
    rows = await db
      .select({
        role: aiModelPreferences.role,
        provider: aiModelPreferences.provider,
        modelId: aiModelPreferences.modelId,
      })
      .from(aiModelPreferences)
      .where(eq(aiModelPreferences.userId, userId))
  } catch (error) {
    if (!isMissingTable(error)) throw error
    console.warn(
      "[provider-settings] ai_model_preferences does not exist yet; every role uses its ladder. Apply drizzle/0008_role_models.sql."
    )
    return {}
  }

  if (rows.length === 0) return {}

  const selection = await getProviderSelection(userId)
  const preferences: Partial<Record<ModelRole, RoleModelPreference>> = {}

  for (const row of rows) {
    if (!ROLES.has(row.role)) continue
    const role = row.role as ModelRole
    const preference: RoleModelPreference = {
      provider: row.provider as ProviderId,
      modelId: row.modelId,
    }
    if (!catalogCandidateFor(role, preference, selection)) continue
    preferences[role] = preference
  }

  return preferences
}

/**
 * Chooses the model that leads one role, or clears the choice with `null`.
 *
 * Validation is against the catalogue the person actually has access to, so a
 * request cannot store a model from a provider they disabled, or one that does
 * not exist. An unknown identity is rejected rather than saved and ignored.
 */
export async function saveModelPreference(
  userId: string,
  role: string,
  preference: RoleModelPreference | null
): Promise<
  | { ok: true; preferences: Partial<Record<ModelRole, RoleModelPreference>> }
  | { ok: false; error: string }
> {
  if (!ROLES.has(role)) return { ok: false, error: "Rol desconocido." }
  const typedRole = role as ModelRole

  if (preference) {
    if (!(PROVIDER_IDS as readonly string[]).includes(preference.provider)) {
      return { ok: false, error: "Proveedor desconocido." }
    }

    const selection = await getProviderSelection(userId)
    const candidate = catalogCandidateFor(typedRole, preference, selection)
    if (!candidate) {
      return {
        ok: false,
        error:
          "Ese modelo no está disponible para este rol con los proveedores que tienes activos.",
      }
    }
  }

  if (preference) {
    await db
      .insert(aiModelPreferences)
      .values({
        userId,
        role: typedRole,
        provider: preference.provider,
        modelId: preference.modelId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [aiModelPreferences.userId, aiModelPreferences.role],
        set: {
          provider: preference.provider,
          modelId: preference.modelId,
          updatedAt: new Date(),
        },
      })
  } else {
    // "Use the normal ladder again" is a delete, not a sentinel value.
    // Scoped to this role: clearing one must not reset the other six.
    await db
      .delete(aiModelPreferences)
      .where(
        and(
          eq(aiModelPreferences.userId, userId),
          eq(aiModelPreferences.role, typedRole)
        )
      )
  }

  return { ok: true, preferences: await getModelPreferences(userId) }
}
