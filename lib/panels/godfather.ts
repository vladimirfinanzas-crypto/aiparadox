import { generateText } from "ai"

import { roleModel } from "@/lib/model"
import {
  blockKinds,
  createDocument,
  documentSummary,
  mergePanelDocuments,
  type PanelDocument,
} from "@/lib/panels/document"

// ---------------------------------------------------------------------------
// Godfather, inside Workspace.
//
// The model does not write code and does not touch the database: it proposes a
// document made of blocks from the fixed catalogue, the server normalizes and
// clamps it, and the person decides whether it becomes a new version of their
// tool. The same function backs the contextual panel inside Workspace and the
// chat tools in lib/workspace-tools.ts, so both surfaces behave identically.
// ---------------------------------------------------------------------------

export type PanelTurn = { role: "user" | "assistant"; text: string }

/**
 * What Godfather understood about the request, before anything is saved:
 * the fields it identified, the operations it would need and the services those
 * operations imply. The strings come from the model; the server re-checks which
 * of them are actually available (actions/workspace.ts), so a proposal never
 * promises an operation this deployment cannot run.
 */
export type PanelAnalysis = {
  purpose: string
  fields: string[]
  actions: string[]
  integrations: string[]
  notes: string[]
}

export type PanelProposal = {
  ok: boolean
  message: string
  name?: string
  document?: PanelDocument
  analysis?: PanelAnalysis
  issues: string[]
  attempts: number
}

/** The catalogue, as the model needs to read it. */
const CATALOGUE = `- heading: { "type": "heading", "text": "Título", "level": 1|2|3 }
- text: { "type": "text", "text": "Una frase o párrafo" }
- stats: { "type": "stats", "title": "Resumen", "items": [{ "label": "Abiertas", "value": "3", "hint": "opcional" }] }
- table: { "type": "table", "title": "Tareas", "columns": ["Tarea", "Estado"], "rows": [{ "id": "fila-1", "cells": ["", ""] }] }
- checklist: { "type": "checklist", "title": "Hoy", "items": [{ "id": "item-1", "label": "Revisar correo", "detail": "opcional", "done": false }] }
- list: { "type": "list", "title": "Ideas", "items": [{ "id": "item-1", "title": "Idea", "detail": "opcional", "status": "abierta" }] }
- calendar: { "type": "calendar", "title": "Agenda", "events": [{ "id": "evento-1", "date": "2026-01-20", "title": "Publicar", "detail": "opcional" }] }
- form: { "type": "form", "title": "Registrar sesión", "submitLabel": "Guardar", "fields": [{ "id": "campo-1", "label": "Fecha", "kind": "text"|"textarea"|"date"|"select", "options": ["A", "B"], "value": "" }] }
- chart: { "type": "chart", "title": "Progreso", "series": [{ "label": "Semana 1", "value": 3 }] }`

const SYSTEM = `Eres Godfather construyendo una herramienta dentro de Workspace en Paradox.

Una herramienta es un panel: un documento JSON compuesto de bloques de un catálogo fijo. No escribes código, ni HTML, ni CSS, ni JavaScript. El catálogo es el único vocabulario disponible.

Devuelves SIEMPRE un único objeto JSON con esta forma exacta:
{
  "message": "una o dos frases en español explicando qué construiste o qué falta",
  "name": "nombre corto de la herramienta (máx. 60 caracteres)",
  "description": "una línea sobre para qué sirve (máx. 140 caracteres)",
  "analysis": {
    "purpose": "qué problema resuelve, en una frase",
    "fields": ["cada campo o dato que la persona tendrá que introducir"],
    "actions": ["cada operación real que querrá ejecutar desde el panel"],
    "integrations": ["servicio externo que esas operaciones necesitarían"],
    "notes": ["lo que falta decidir o configurar, si algo falta"]
  },
  "blocks": [ ...bloques... ]
}

Reglas de "analysis":
- fields: máx. 8, concretos ("fecha", "enlace", "cuenta", "estado"), no genéricos.
- actions: solo operaciones que el usuario querría ejecutar ("guardar borrador", "traer cuentas"). Máx. 6.
- integrations: solo servicios reales de Paradox si de verdad los necesitas: Godfather/IA, navegador en la nube, equipo local, redes sociales, correo. Si todo funciona dentro del panel, devuelve []. No inventes servicios.
- notes: máx. 5 frases cortas y accionables.

Reglas de los bloques:
- Entre 1 y 24 bloques. Cada uno con "id" único, en minúsculas, sin espacios.
- Usa SOLO estos tipos: ${blockKinds.join(", ")}.
- Catálogo con la forma exacta de cada bloque:
${CATALOGUE}
- La herramienta se usa, no se lee: incluye las secciones que la persona va a rellenar (tabla, checklist, lista, calendario, formulario) y deja sus filas vacías o con un ejemplo mínimo. No la llenes de párrafos.
- No inventes integraciones, envíos, publicaciones ni sincronizaciones: si la petición necesita un servicio que no existe, dilo en "notes" y construye la parte que sí funciona en local.
- Si falta un dato imprescindible (fechas concretas, nombres, importes), no lo inventes: deja el bloque preparado y explica en "notes" qué falta.
- Si ya existe un documento, MODIFÍCALO: conserva los bloques que la persona usa (mismo id y mismo tipo) y cambia solo lo que pidió.
- Responde en español, sin markdown y sin explicar el JSON.`

/** Model output is untrusted: a list of short strings, or nothing. */
function stringList(value: unknown, max: number, maxLength = 120): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, maxLength))
    .slice(0, max)
}

function analyzePayload(raw: unknown): PanelAnalysis | undefined {
  const value =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}

  const analysis: PanelAnalysis = {
    purpose: typeof value.purpose === "string" ? value.purpose.trim().slice(0, 240) : "",
    fields: stringList(value.fields, 8, 60),
    actions: stringList(value.actions, 6, 80),
    integrations: stringList(value.integrations, 6, 60),
    notes: stringList(value.notes, 5, 200),
  }

  const empty =
    !analysis.purpose &&
    analysis.fields.length === 0 &&
    analysis.actions.length === 0 &&
    analysis.integrations.length === 0 &&
    analysis.notes.length === 0

  return empty ? undefined : analysis
}

function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1]! : trimmed

  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start === -1 || end <= start) return null

  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Ask the model for a panel that satisfies `instruction`, normalize it against
 * the catalogue, and give it one chance to repair itself. `current` turns this
 * into a change request: blocks the person already has keep their saved data.
 */
export async function proposePanel({
  instruction,
  current,
  name,
  history = [],
}: {
  instruction: string
  current?: PanelDocument
  name?: string
  history?: PanelTurn[]
}): Promise<PanelProposal> {
  const context = [
    ...(name ? [`Herramienta actual: «${name}».`] : []),
    ...(current
      ? [
          "Documento actual de la herramienta (las filas o elementos que aparecen son datos que la persona ya guardó; consérvalos):",
          JSON.stringify(current, null, 1),
        ]
      : ["Todavía no existe la herramienta: créala desde cero."]),
    ...(history.length > 0
      ? [
          "",
          "Conversación previa:",
          ...history.map(
            (turn) => `${turn.role === "user" ? "Persona" : "Godfather"}: ${turn.text}`
          ),
        ]
      : []),
  ].join("\n")

  let lastIssues: string[] = []
  let lastMessage = ""

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const repair =
      attempt === 1
        ? ""
        : `\n\nTu respuesta anterior no servía: ${lastIssues.join(" ")} Devuelve el objeto completo con bloques válidos del catálogo.`

    let text = ""
    try {
      const result = await generateText({
        model: roleModel("reasoner"),
        system: SYSTEM,
        prompt: `${context}\n\nPetición de la persona:\n${instruction}${repair}`,
        temperature: 0.2,
        maxOutputTokens: 3_000,
      })
      text = result.text
    } catch (error) {
      // A provider failure is reported as a message, never as a saved panel.
      return {
        ok: false,
        message:
          error instanceof Error && error.message
            ? `No pude contactar con el modelo: ${error.message.slice(0, 200)}`
            : "No pude contactar con el modelo.",
        issues: ["provider"],
        attempts: attempt,
      }
    }

    const payload = extractJson(text) as {
      message?: unknown
      name?: unknown
      description?: unknown
      analysis?: unknown
      blocks?: unknown
    } | null

    lastMessage =
      typeof payload?.message === "string" && payload.message.trim()
        ? payload.message.trim().slice(0, 900)
        : text.trim().slice(0, 900)

    const proposedName =
      typeof payload?.name === "string" ? payload.name.trim().slice(0, 60) : undefined
    const proposedDescription =
      typeof payload?.description === "string"
        ? payload.description.trim().slice(0, 140)
        : undefined

    const analysis = analyzePayload(payload?.analysis)

    const document = createDocument({
      description: proposedDescription,
      blocks: payload?.blocks,
    })

    if (document.blocks.length === 0) {
      lastIssues = [
        `no enviaste bloques del catálogo (${blockKinds.join(", ")}).`,
      ]
      continue
    }

    // Changing an existing tool must not throw away what is inside it: blocks
    // that survived keep their rows, ticks, events and typed values.
    const merged = current ? mergePanelDocuments(current, document) : document

    return {
      ok: true,
      message: lastMessage,
      name: proposedName,
      document: merged,
      ...(analysis ? { analysis } : {}),
      issues: [],
      attempts: attempt,
    }
  }

  return {
    ok: false,
    message: lastMessage || "No pude construir una herramienta válida con eso.",
    issues: lastIssues,
    attempts: 2,
  }
}

/** One line for the chat, where the panel itself cannot be shown. */
export function describePanel(document: PanelDocument): string {
  return documentSummary(document)
}
