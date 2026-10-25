import { generateText } from "ai"

import { roleModel } from "@/lib/model"
import {
  approvalSummary,
  describeTrigger,
} from "@/lib/automations/summary"
import {
  emptyDefinition,
  parseDefinition,
  type AutomationDefinition,
} from "@/lib/automations/definition"
import { nodeCatalog } from "@/lib/automations/catalog"
import { validateDefinition } from "@/lib/automations/validate"
import { availableEnvNames } from "@/lib/automations/env"
import {
  getAutomation,
  saveAutomationDefinition,
} from "@/queries/automations"

// Godfather's hands on an automation.
//
// The model never gets to write code or to touch the database directly: it
// proposes a definition, the server validates it, the person sees it in the
// canvas, and only an explicit approval lets it run on its own. The same
// functions back the contextual panel inside Automations and the general chat
// tools, so both surfaces behave identically.

export type AutomationSnapshot = {
  id: string
  name: string
  status: string
  version: number
  definition: AutomationDefinition
  summary: ReturnType<typeof approvalSummary>
}

export async function automationSnapshot(
  userId: string,
  id: string
): Promise<AutomationSnapshot | null> {
  const automation = await getAutomation(userId, id)
  if (!automation) return null

  const definition =
    automation.definition ?? emptyDefinition(automation.name, automation.timezone)

  return {
    id: automation.id,
    name: automation.name,
    status: automation.status,
    version: automation.version,
    definition,
    summary: approvalSummary(definition),
  }
}

/** The catalogue, in the shape the model needs to choose blocks. */
function catalogForPrompt() {
  return Object.values(nodeCatalog).map((node) => ({
    type: node.type,
    kind: node.kind,
    label: node.label,
    description: node.description,
    environment: node.environment,
    fields: node.fields.map((field) => ({
      key: field.key,
      label: field.label,
      required: Boolean(field.required),
      ...("multiline" in field && field.multiline ? { multiline: true } : {}),
    })),
    outputs: node.outputs.map((output) => output.path),
    effects: node.effects,
  }))
}

const SYSTEM = `Eres Godfather construyendo automatizaciones dentro de Paradox.

Devuelves SIEMPRE un único objeto JSON con esta forma exacta:
{
  "message": "una o dos frases para la persona, en español, explicando qué construiste o qué falta",
  "definition": { ... }
}

Reglas de la definición:
- schemaVersion siempre 2.
- Un único bloque "start" de tipo "start" y kind "trigger".
- Cada bloque: { id (único, sin espacios), type, kind, title, config (strings), position {x,y} }.
- kind: "trigger" para start, "condition" para condition, "action" para el resto.
- Las conexiones son { id, source, target } y, si salen de una condición, además sourceHandle: "true" o "false".
- Usa SOLO estos tipos: {{TIPOS}}.
- Rellena los campos obligatorios de cada bloque.
- Para pasar datos de un bloque a otro usa {{ nodeId.path }} con las salidas documentadas.
- trigger: { kind: "manual" | "cron" | "once", cron?, runAt?, timezone }.
  Para cron usa 5 campos (por ejemplo "0 9 * * 1"). La zona horaria es IANA.
- settings: { onError: "stop" | "continue", retries: 0-3, maxSteps: 1-80, timeoutMs: 5000-3600000 }.
- Coloca los bloques de izquierda a derecha: x = 260 * posición, y = 0 salvo ramas (y = 140 en la rama "false").
- Si el objetivo necesita un dato que no tienes (destinatario de un correo, URL, red social), NO lo inventes: usa manual y explica en "message" qué falta.
- Nunca añadas bloques que no existan en el catálogo.
- No actives nada: solo propones el borrador.`

export type ProposalResult = {
  message: string
  definition?: AutomationDefinition
  issues: Array<{ code: string; message: string; nodeId?: string }>
  ok: boolean
  attempts: number
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

/** Ask the model for a flow that satisfies `instruction`, validate it, and give
 *  it one chance to repair itself using the validator's own messages. */
export async function proposeDefinition({
  instruction,
  current,
  timezone = "UTC",
  history = [],
}: {
  instruction: string
  current?: AutomationDefinition
  timezone?: string
  history?: Array<{ role: "user" | "assistant"; text: string }>
}): Promise<ProposalResult> {
  const types = Object.keys(nodeCatalog).join(", ")
  const system = SYSTEM.replace("{{TIPOS}}", types)

  const context = [
    `Zona horaria de la persona: ${timezone}.`,
    ...(history.length > 0
      ? [
          "",
          "Conversación previa:",
          ...history.map(
            (turn) => `${turn.role === "user" ? "Persona" : "Godfather"}: ${turn.text}`
          ),
        ]
      : []),
    "",
    "Catálogo de bloques:",
    JSON.stringify(catalogForPrompt(), null, 1),
    "",
    "Definición actual (puede estar vacía; si existe, modifícala en lugar de empezar de cero):",
    JSON.stringify(current ?? emptyDefinition("Nueva automatización", timezone), null, 1),
  ].join("\n")


  let lastIssues: ProposalResult["issues"] = []
  let lastMessage = ""

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const repair =
      attempt === 1
        ? ""
        : `\n\nTu propuesta anterior no pasó la validación. Corrige exactamente esto y devuelve la definición completa:\n${lastIssues
            .map((issue) => `- ${issue.message}`)
            .join("\n")}`

    const { text } = await generateText({
      model: roleModel("reasoner"),
      system,
      prompt: `${context}\n\nPetición de la persona:\n${instruction}${repair}`,
      temperature: 0.2,
      maxOutputTokens: 3_500,
    })

    const payload = extractJson(text) as { message?: unknown; definition?: unknown } | null
    lastMessage =
      typeof payload?.message === "string" && payload.message.trim()
        ? payload.message.trim().slice(0, 900)
        : text.trim().slice(0, 900)

    const parsed = parseDefinition(payload?.definition)
    if (!parsed.ok) {
      lastIssues = parsed.issues.map((message) => ({ code: "schema", message }))
      continue
    }

    const report = validateDefinition(parsed.definition, {
      availableEnv: availableEnvNames(),
    })

    if (report.ok) {
      return {
        message: lastMessage,
        definition: parsed.definition,
        issues: [],
        ok: true,
        attempts: attempt,
      }
    }

    lastIssues = report.errors.map((issue) => ({
      code: issue.code,
      message: issue.message,
      ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
    }))
  }

  return { message: lastMessage, issues: lastIssues, ok: false, attempts: 2 }
}

/** Persist a proposal as a new version of an existing automation. */
export async function applyProposal({
  userId,
  id,
  definition,
}: {
  userId: string
  id: string
  definition: AutomationDefinition
}) {
  return saveAutomationDefinition({
    userId,
    id,
    definition,
    author: "godfather",
    summary: "Cambio propuesto por Godfather",
  })
}

/** One-line description used by the general chat, where the flow cannot be
 *  shown on screen. */
export function describeDefinition(definition: AutomationDefinition): string {
  const blocks = definition.nodes
    .filter((node) => node.type !== "start")
    .map((node) => node.title)
    .join(" → ")
  return `${describeTrigger(definition.trigger)}: ${blocks || "sin bloques"}`
}
