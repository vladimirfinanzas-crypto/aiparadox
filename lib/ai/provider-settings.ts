import { asc, eq } from "drizzle-orm"

import { db } from "@/db"
import { aiProviderSettings } from "@/db/schema"

import { disabledProviders, providerOrder } from "./models"
import { PROVIDER_IDS, type ProviderId } from "./types"

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
 * The person's selection, already merged with the environment's rules.
 *
 * Rows are only written when someone saves, so an untouched account does no
 * query work beyond one empty read.
 */
export async function getProviderSelection(
  userId: string
): Promise<ResolvedProviderSelection> {
  const rows = await db
    .select({
      provider: aiProviderSettings.provider,
      enabled: aiProviderSettings.enabled,
      position: aiProviderSettings.position,
    })
    .from(aiProviderSettings)
    .where(eq(aiProviderSettings.userId, userId))
    .orderBy(asc(aiProviderSettings.position))

  const envDisabled = disabledProviders()

  if (rows.length === 0) return defaultSelection()

  const ordered = knownOnly(rows.map((row) => row.provider))
  const chosenDisabled = knownOnly(
    rows.filter((row) => !row.enabled).map((row) => row.provider)
  )

  // Providers added to the product after this person saved keep their place at
  // the end instead of disappearing from their routing.
  const rest = providerOrder().filter((id) => !ordered.includes(id))

  return {
    order: [...ordered, ...rest],
    disabled: [...new Set([...envDisabled, ...chosenDisabled])],
  }
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
