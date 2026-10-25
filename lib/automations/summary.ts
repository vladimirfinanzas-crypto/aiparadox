import { catalogFor, executionTargetOf, type AutomationExecutionTarget } from "@/lib/automations/catalog"
import type { AutomationDefinition, AutomationTrigger } from "@/lib/automations/definition"

// What a person is agreeing to when they activate a flow, in their language.
// Pure (no crypto, no database) so the editor can render it on the client and
// the server can hand the same text to Godfather.

export type ApprovalAction = {
  nodeId: string
  type: string
  label: string
  details: string
}

const DAYS = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
]

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
]

function pad(value: number) {
  return String(value).padStart(2, "0")
}

/** A cron expression in words, for the common cases. Falls back to the raw
 *  expression, which is better than claiming something wrong. */
export function describeCron(cron: string | undefined): string {
  const expression = (cron ?? "").trim()
  if (!expression) return "Sin frecuencia"

  const parts = expression.split(/\s+/)
  if (parts.length !== 5) return expression
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]

  if (minute === "*" && hour === "*") return "Cada minuto"
  if (/^\*\/\d+$/.test(minute) && hour === "*") {
    return `Cada ${minute.slice(2)} minutos`
  }

  const time = /^\d{1,2}$/.test(hour) && /^\d{1,2}$/.test(minute)
    ? `${pad(Number(hour))}:${pad(Number(minute))}`
    : undefined

  if (time) {
    if (dayOfWeek !== "*" && /^[0-6](,[0-6])*$/.test(dayOfWeek)) {
      const days = dayOfWeek
        .split(",")
        .map((day) => DAYS[Number(day)] ?? day)
        .join(", ")
      return `Cada ${days} a las ${time}`
    }
    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return `Todos los días a las ${time}`
    }
    if (dayOfMonth !== "*" && month === "*" && dayOfWeek === "*") {
      return `El día ${dayOfMonth} de cada mes a las ${time}`
    }
  }

  return expression
}

export function describeTrigger(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case "cron":
      return `${describeCron(trigger.cron)} (${trigger.timezone})`
    case "once": {
      if (!trigger.runAt) return "Una sola vez, sin fecha"
      const date = new Date(trigger.runAt)
      if (Number.isNaN(date.getTime())) return "Una sola vez, fecha inválida"
      return `Una sola vez el ${date.getDate()} de ${MONTHS[date.getMonth()]} de ${date.getFullYear()} a las ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }
    default:
      return "Solo cuando lo pidas tú"
  }
}

/** One entry per block with consequences outside Paradox. Blocks that only read
 *  or wait are left out: they are not what someone is approving. */
export function approvalActions(definition: AutomationDefinition): ApprovalAction[] {
  return definition.nodes.flatMap((node) => {
    const catalog = catalogFor(node.type)
    if (!catalog || catalog.effects.length === 0) return []

    const details = catalog.fields
      .filter((field) => node.config[field.key])
      .map((field) => `${field.label}: ${node.config[field.key]}`)
      .join(" · ")

    return [
      {
        nodeId: node.id,
        type: node.type,
        label: `${node.title} — ${catalog.effects.join(", ")}`,
        details,
      },
    ]
  })
}

export type ApprovalSummary = {
  name: string
  description?: string
  trigger: string
  triggerKind: AutomationTrigger["kind"]
  timezone: string
  target: AutomationExecutionTarget
  actions: ApprovalAction[]
  effects: string[]
  integrations: string[]
  nodeCount: number
}

export function approvalSummary(definition: AutomationDefinition): ApprovalSummary {
  const actions = approvalActions(definition)
  const integrations = new Set<string>()
  for (const node of definition.nodes) {
    for (const name of catalogFor(node.type)?.requires ?? []) integrations.add(name)
  }

  return {
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    trigger: describeTrigger(definition.trigger),
    triggerKind: definition.trigger.kind,
    timezone: definition.trigger.timezone,
    target: executionTargetOf(definition.nodes),
    actions,
    effects: [...new Set(actions.flatMap((action) => catalogFor(action.type)?.effects ?? []))],
    integrations: [...integrations],
    nodeCount: definition.nodes.length,
  }
}
