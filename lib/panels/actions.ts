// ---------------------------------------------------------------------------
// Panel actions — availability and execution (server only).
//
// The catalogue (what exists and what each action needs) lives in
// ./action-catalog, because the panel document is read in the browser. This
// file is the server half: it re-checks the requirement against the real
// environment at click time and runs the authorised operation.
//
// Rules:
//   - the requirement is never trusted from the client: an action that became
//     unavailable between page load and click fails with its reason.
//   - every executor is read-only or writes content for the person. Nothing
//     here publishes, sends or deletes anything externally; those effects belong
//     to flows with their own explicit confirmation.
// ---------------------------------------------------------------------------

import { onlineDevices } from "@/lib/desktop-devices"
import { listAccounts } from "@/lib/zernio"
import { roleModel } from "@/lib/model"
import { generateText } from "ai"

import {
  panelAction,
  panelActions,
  type PanelActionId,
  type PanelActionRequirement,
} from "@/lib/panels/action-catalog"

export {
  panelAction,
  panelActions,
  normalizePanelActions,
  panelActionIds,
  type PanelActionDef,
  type PanelActionId,
  type PanelActionRequirement,
} from "@/lib/panels/action-catalog"

// ---------------------------------------------------------------------------
// Availability — checked on the server, per request
// ---------------------------------------------------------------------------

export type ActionAvailability = {
  id: PanelActionId
  available: boolean
  /** Why it is not available, in words the panel can show directly. */
  reason?: string
  configureHref?: string
}

type Env = Record<string, string | undefined>

function hasEnv(env: Env, names: string[]): boolean {
  return names.every((name) => env[name]?.trim())
}

/**
 * Whether each action can run right now, for this account and this server.
 *
 * Every check is a real one: a variable that exists, a device with a recent
 * heartbeat. Nothing is inferred from configuration the person wrote into the
 * panel.
 */
export async function panelActionAvailability(
  userId: string,
  env: Env = process.env,
  deps: {
    listAccounts?: (userId: string) => Promise<unknown>
    onlineDevices?: (userId: string) => Promise<unknown>
  } = {}
): Promise<ActionAvailability[]> {
  const results: ActionAvailability[] = []

  // One AI check for both Godfather actions: they share the same model layer.
  let aiAvailable = hasEnv(env, ["OPENROUTER_API_KEY"])
  if (!aiAvailable) {
    // Any other configured provider answers just as well
    aiAvailable = [
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GOOGLE_API_KEY",
      "CEREBRAS_API_KEY",
      "GROQ_API_KEY",
    ].some((name) => hasEnv(env, [name]))
  }
  // Workers AI needs both its token and an account id
  if (!aiAvailable) {
    aiAvailable = hasEnv(env, ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"])
  }

  for (const action of panelActions) {
    switch (action.requirement) {
      case "ai": {
        results.push({
          id: action.id,
          available: aiAvailable,
          ...(aiAvailable ? {} : { reason: action.needs, configureHref: action.configureHref }),
        })
        break
      }
      case "zernio": {
        const configured = hasEnv(env, ["ZERNIO_API_KEY"])
        let reachable = configured
        if (configured) {
          try {
            await (deps.listAccounts ?? listAccounts)(userId)
          } catch {
            // The key exists but the service does not answer: reported as
            // unavailable rather than "available" with a failing button.
            reachable = false
          }
        }
        results.push({
          id: action.id,
          available: reachable,
          ...(reachable
            ? {}
            : {
                reason: configured
                  ? "Zernio no respondió con esta clave."
                  : action.needs,
                configureHref: action.configureHref,
              }),
        })
        break
      }
      case "local_device": {
        let online = 0
        try {
          const devices = (await (deps.onlineDevices ?? onlineDevices)(userId)) as unknown[]
          online = Array.isArray(devices) ? devices.length : 0
        } catch {
          online = 0
        }
        results.push({
          id: action.id,
          available: online > 0,
          ...(online > 0
            ? {}
            : { reason: action.needs, configureHref: action.configureHref }),
        })
        break
      }
    }
  }

  return results
}

/**
 * Whether one requirement holds right now, for the integrations a proposal
 * mentions. Used by the creation flow to say which services exist on this
 * deployment — including ones no catalogue action needs (Browserbase, email),
 * where "configured" is reported without inventing a button for it.
 */
export async function requirementAvailability(
  userId: string,
  requirement: PanelActionRequirement,
  env: Env = process.env,
  deps: {
    onlineDevices?: (userId: string) => Promise<unknown>
  } = {}
): Promise<{ available: boolean; reason?: string; configureHref?: string }> {
  switch (requirement) {
    case "ai": {
      const [entry] = await panelActionAvailability(userId, env, deps).then((list) =>
        list.filter((item) => item.id === "godfather.draft")
      )
      return entry?.available
        ? { available: true }
        : { available: false, reason: entry?.reason, configureHref: entry?.configureHref }
    }
    case "zernio": {
      const [entry] = await panelActionAvailability(userId, env, deps).then((list) =>
        list.filter((item) => item.id === "zernio.accounts")
      )
      return entry?.available
        ? { available: true }
        : { available: false, reason: entry?.reason, configureHref: entry?.configureHref }
    }
    case "local_device": {
      const [entry] = await panelActionAvailability(userId, env, deps).then((list) =>
        list.filter((item) => item.id === "desktop.devices")
      )
      return entry?.available
        ? { available: true }
        : { available: false, reason: entry?.reason, configureHref: entry?.configureHref }
    }
    case "cloud_browser": {
      const available = hasEnv(env, [
        "BROWSERBASE_API_KEY",
        "BROWSERBASE_PROJECT_ID",
      ])
      return available
        ? { available: true }
        : {
            available: false,
            reason: "Faltan BROWSERBASE_API_KEY y BROWSERBASE_PROJECT_ID en el servidor.",
            configureHref: "/settings/integrations",
          }
    }
    case "email": {
      const available = hasEnv(env, ["RESEND_API_KEY"])
      return available
        ? { available: true }
        : {
            available: false,
            reason: "Falta RESEND_API_KEY en el servidor.",
            configureHref: "/settings/integrations",
          }
    }
    default:
      return { available: false, reason: "Integración desconocida." }
  }
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

export type PanelActionOutcome =
  | {
      ok: true
      /** Human text the panel can show or write into a block. */
      text: string
      /** Rows, when the action produced structured data. */
      rows?: string[][]
      columns?: string[]
      ms: number
    }
  | { ok: false; code: "integration_missing" | "failed"; reason: string }

const DRAFT_MAX = 1_200

/** Real model call: writes text for the person, using their own provider ladder. */
async function runDraft(input: {
  instruction: string
  panelName: string
  context: string
  mode: "draft" | "summary"
}): Promise<string> {
  const system =
    input.mode === "summary"
      ? "Eres Godfather. Resume en una sola frase, en español, qué contiene este panel de trabajo. No inventes datos que no estén en el contenido."
      : "Eres Godfather redactando contenido para un panel de trabajo. Devuelve solo el texto útil en español, sin preámbulos ni comillas."

  const result = await generateText({
    model: roleModel("creative"),
    system,
    prompt: `Panel: ${input.panelName}\n\nContenido actual:\n${input.context || "(vacío)"}\n\nPetición: ${input.instruction}`,
    temperature: 0.6,
    maxOutputTokens: 700,
  })

  return result.text.trim().slice(0, DRAFT_MAX)
}

/**
 * Runs one action for a panel the caller already owns.
 *
 * `requirement` is re-checked here, not trusted from the client: an action
 * that became unavailable between page load and click fails with the reason,
 * never by half-executing.
 */
export async function runPanelAction(input: {
  userId: string
  actionId: string
  instruction: string
  panelName: string
  /** Text of the panel, gathered by the caller so it stays cheap and simple. */
  context: string
  env?: Env
  deps?: Parameters<typeof panelActionAvailability>[2]
}): Promise<PanelActionOutcome> {
  const def = panelAction(input.actionId)
  if (!def) {
    return { ok: false, code: "failed", reason: "Esa acción no existe." }
  }

  const started = Date.now()
  const [availability] = await panelActionAvailability(
    input.userId,
    input.env,
    input.deps
  ).then((list) => list.filter((entry) => entry.id === def.id))

  if (!availability?.available) {
    return {
      ok: false,
      code: "integration_missing",
      reason: availability?.reason ?? def.needs,
    }
  }

  try {
    switch (def.id) {
      case "godfather.draft":
      case "godfather.summary": {
        const text = await runDraft({
          instruction:
            input.instruction.trim() ||
            (def.id === "godfather.summary"
              ? "Resume este panel."
              : "Escribe el contenido que este panel necesita."),
          panelName: input.panelName,
          context: input.context.slice(0, 6_000),
          mode: def.id === "godfather.summary" ? "summary" : "draft",
        })
        return { ok: true, text, ms: Date.now() - started }
      }

      case "zernio.accounts": {
        const accounts = (await listAccounts(input.userId)) as Array<{
          platform?: string
          username?: string
          isActive?: boolean
        }>
        const rows = (Array.isArray(accounts) ? accounts : []).slice(0, 50).map(
          (account) => [
            String(account.platform ?? ""),
            String(account.username ?? ""),
            account.isActive ? "conectada" : "desconectada",
          ]
        )
        return {
          ok: true,
          columns: ["Red", "Usuario", "Estado"],
          rows,
          text:
            rows.length > 0
              ? `${rows.length} cuenta${rows.length === 1 ? "" : "s"} conectada${rows.length === 1 ? "" : "s"}.`
              : "No hay cuentas conectadas todavía.",
          ms: Date.now() - started,
        }
      }

      case "desktop.devices": {
        const devices = (await onlineDevices(input.userId)) as Array<{
          name?: string
          os?: string
          status?: string
        }>
        const rows = (Array.isArray(devices) ? devices : []).map((device) => [
          String(device.name ?? ""),
          String(device.os ?? ""),
          String(device.status ?? ""),
        ])
        return {
          ok: true,
          columns: ["Equipo", "Sistema", "Estado"],
          rows,
          text: `${rows.length} equipo${rows.length === 1 ? "" : "s"} en línea.`,
          ms: Date.now() - started,
        }
      }
    }
  } catch (error) {
    return {
      ok: false,
      code: "failed",
      reason:
        error instanceof Error
          ? error.message.slice(0, 300)
          : "La acción no se pudo completar.",
    }
  }

  return { ok: false, code: "failed", reason: "Acción no implementada." }
}
