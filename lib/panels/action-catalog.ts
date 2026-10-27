// ---------------------------------------------------------------------------
// The panel action catalogue — data only.
//
// This module is imported by the panel document, which reaches the browser, so
// it deliberately has NO imports: no SDK, no database, no model. Availability
// and execution live in lib/panels/actions.ts, which is server-only.
//
// Rules:
//   - only actions this app really implements appear here; a button that cannot
//     run is worse than no button.
//   - each action declares what it needs, so the server checks that need before
//     doing anything instead of assuming a configuration from a saved panel.
// ---------------------------------------------------------------------------

export type PanelActionId = "godfather.draft" | "godfather.summary" | "zernio.accounts" | "desktop.devices"

export type PanelActionRequirement =
  /** Any AI provider configured on the server. */
  | "ai"
  /** A Desktop Agent online for this account. */
  | "local_device"
  /** Zernio key (social accounts). */
  | "zernio"
  /**
   * Also used to report an integration a proposal mentions but that no catalogue
   * action needs today (Browserbase, email): the analysis shows whether it is
   * configured without pretending an action exists for it.
   */
  | "cloud_browser"
  | "email"

export type PanelActionDef = {
  id: PanelActionId
  label: string
  description: string
  requirement: PanelActionRequirement
  /** Human sentence for the requirement, shown when it is missing. */
  needs: string
  /** Where to fix it, when the fix lives in Settings. */
  configureHref?: string
}

export const panelActions: PanelActionDef[] = [
  {
    id: "godfather.draft",
    label: "Redactar con Godfather",
    description:
      "Escribe contenido para este panel (ideas, publicaciones, textos) usando los modelos configurados.",
    requirement: "ai",
    needs: "Godfather necesita al menos un proveedor de IA configurado.",
    configureHref: "/settings/integrations",
  },
  {
    id: "godfather.summary",
    label: "Resumir este panel",
    description:
      "Godfather lee lo que hay en el panel y propone un resumen en una frase.",
    requirement: "ai",
    needs: "Godfather necesita al menos un proveedor de IA configurado.",
    configureHref: "/settings/integrations",
  },
  {
    id: "zernio.accounts",
    label: "Traer mis cuentas sociales",
    description:
      "Rellena una lista con las cuentas conectadas en Zernio, con su usuario y estado.",
    requirement: "zernio",
    needs: "Falta ZERNIO_API_KEY en el servidor.",
    configureHref: "/settings/integrations",
  },
  {
    id: "desktop.devices",
    label: "Estado de mis equipos",
    description:
      "Rellena una tabla con los ordenadores vinculados y si responden ahora mismo.",
    requirement: "local_device",
    needs: "Ningún equipo con Paradox Desktop Agent está en línea.",
    configureHref: "/settings/desktop-agent",
  },
]

const byId = new Map<string, PanelActionDef>(panelActions.map((entry) => [entry.id, entry]))

export function panelAction(id: string): PanelActionDef | null {
  return byId.get(id) ?? null
}

/** Every known id — what a stored panel's `actions` list is validated against. */
export const panelActionIds = panelActions.map((entry) => entry.id)

/**
 * The enabled actions of a document, cleaned: unknown ids dropped, duplicates
 * removed, order preserved. A panel saved before this feature comes back with
 * none, which is the correct answer rather than an error.
 */
export function normalizePanelActions(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  for (const id of input) {
    if (typeof id === "string" && byId.has(id)) seen.add(id)
  }
  return panelActionIds.filter((id) => seen.has(id))
}

// The integrations Godfather names come as free text ("redes sociales",
// "equipo local"). This maps them to the requirement the server can actually
// check; anything unmatched is reported as unknown instead of being guessed.
const requirementKeywords: Array<[PanelActionRequirement, RegExp]> = [
  ["ai", /godfather|\bia\b|modelo|openrouter|gemini|cerebras|groq|cloudflare|llm/i],
  ["zernio", /zernio|redes?|social|instagram|twitter|linkedin|tiktok|publicaci/i],
  ["local_device", /equipo|local|escritorio|desktop|agente|pc\b|ordenador/i],
  ["cloud_browser", /browserbase|playwright|navegador|nube|cloud browser/i],
  ["email", /correo|email|resend|mail/i],
]

export function matchRequirement(name: string): PanelActionRequirement | null {
  const text = name.trim()
  if (!text) return null
  for (const [requirement, pattern] of requirementKeywords) {
    if (pattern.test(text)) return requirement
  }
  return null
}

