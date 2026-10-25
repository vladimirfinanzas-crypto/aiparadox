import { createHash } from "node:crypto"

import { catalogFor, effectsOf, hasExternalEffects } from "@/lib/automations/catalog"
import type { AutomationDefinition } from "@/lib/automations/definition"
import type { AutomationApproval } from "@/db/schema"

// An approval is evidence that someone looked at *this* version of a flow and
// agreed to its consequences. It is tied to a fingerprint of the parts that
// matter — the schedule and every block with an external effect, including its
// configuration. Renaming a block or moving it on the canvas does not revoke
// it; changing the recipient of an email does.

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  )
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`
}

export function automationScopeHash(definition: AutomationDefinition): string {
  const consequential = {
    trigger: {
      kind: definition.trigger.kind,
      cron: definition.trigger.cron ?? null,
      runAt: definition.trigger.runAt ?? null,
      timezone: definition.trigger.timezone,
    },
    onError: definition.settings.onError,
    nodes: definition.nodes
      .filter((node) => hasExternalEffects(node.type))
      .map((node) => ({
        id: node.id,
        type: node.type,
        config: node.config,
        environment: catalogFor(node.type)?.environment ?? "cloud",
      })),
  }

  return createHash("sha256").update(stable(consequential)).digest("hex")
}

/** The approval that covers this exact definition, if there is one. */
export function approvalFor(
  approvals: readonly AutomationApproval[],
  definition: AutomationDefinition,
  { version }: { version: number }
): AutomationApproval | undefined {
  const hash = automationScopeHash(definition)
  const now = Date.now()

  return approvals.find(
    (approval) =>
      approval.version === version &&
      approval.scopeHash === hash &&
      !approval.revokedAt &&
      (!approval.expiresAt || approval.expiresAt.getTime() > now)
  )
}

/** A flow may run on its own only when it is active, has an approval that still
 *  matches the definition, and its schedule exists. */
export function canRunUnattended({
  definition,
  version,
  approvals,
  status,
}: {
  definition: AutomationDefinition
  version: number
  approvals: readonly AutomationApproval[]
  status: string
}): { ok: true } | { ok: false; reason: string } {
  if (status !== "active") {
    return { ok: false, reason: "La automatización no está activa." }
  }
  // A flow that only reads, waits or branches has nothing to approve: it can
  // run on its own as soon as the person activates it. Only flows with
  // consequences outside Paradox need the extra explicit step.
  if (effectsOf(definition.nodes).length === 0) return { ok: true }

  if (!approvalFor(approvals, definition, { version })) {
    return {
      ok: false,
      reason:
        "La definición cambió o nunca se autorizó: hace falta una aprobación de esta versión antes de ejecutarla sola.",
    }
  }
  return { ok: true }
}
