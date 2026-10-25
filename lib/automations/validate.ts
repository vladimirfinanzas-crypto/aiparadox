import toposort from "toposort"

import { catalogFor, effectsOf } from "@/lib/automations/catalog"
import {
  parseDefinition,
  type AutomationDefinition,
  type AutomationNode,
} from "@/lib/automations/definition"
import { placeholdersIn } from "@/lib/automations/expression"

// Everything knowable about a flow before it runs. Pure: the canvas calls it on
// every edit, the server calls it before saving and before running, and the
// agent calls it after writing a definition. One implementation, one verdict.

export type ValidationIssue = {
  level: "error" | "warning"
  code: string
  message: string
  nodeId?: string
}

export type ValidationReport = {
  ok: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  effects: string[]
}

const CRON_TOKEN = /^[0-9A-Za-z*/,\-?LW#]+$/

function isValidCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return false
  return parts.every((part) => CRON_TOKEN.test(part))
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/** Every node that can reach `nodeId`, nearest first. */
function ancestorsOf(nodes: AutomationNode[], edges: AutomationDefinition["edges"], nodeId: string) {
  const incoming = new Map<string, string[]>()
  for (const edge of edges) {
    const list = incoming.get(edge.target) ?? []
    list.push(edge.source)
    incoming.set(edge.target, list)
  }

  const known = new Set(nodes.map((node) => node.id))
  const seen = new Set<string>()
  const queue = [nodeId]
  const result: string[] = []

  while (queue.length) {
    const current = queue.shift()!
    for (const source of incoming.get(current) ?? []) {
      if (seen.has(source) || !known.has(source)) continue
      seen.add(source)
      result.push(source)
      queue.push(source)
    }
  }

  return result
}

export function validateDefinition(
  definition: AutomationDefinition,
  options: { availableEnv?: readonly string[] } = {}
): ValidationReport {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const push = (issue: ValidationIssue) =>
    (issue.level === "error" ? errors : warnings).push(issue)

  const { nodes, edges, trigger, settings } = definition
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const ids = new Set(nodes.map((node) => node.id))

  // --- trigger ------------------------------------------------------------
  if (trigger.kind === "cron") {
    if (!trigger.cron) {
      push({ level: "error", code: "cron-missing", message: "Elige una frecuencia (expresión cron)." })
    } else if (!isValidCron(trigger.cron)) {
      push({
        level: "error",
        code: "cron-invalid",
        message: `"${trigger.cron}" no es una expresión cron válida de cinco campos.`,
      })
    }
  }
  if (trigger.kind === "once") {
    if (!trigger.runAt) {
      push({ level: "error", code: "run-at-missing", message: "Elige la fecha y hora de la ejecución." })
    } else if (Number.isNaN(new Date(trigger.runAt).getTime())) {
      push({ level: "error", code: "run-at-invalid", message: "La fecha de ejecución no es válida." })
    } else if (new Date(trigger.runAt).getTime() < Date.now()) {
      push({
        level: "warning",
        code: "run-at-past",
        message: "La fecha indicada ya pasó: no se ejecutará sola.",
      })
    }
  }
  if (!isValidTimezone(trigger.timezone)) {
    push({
      level: "error",
      code: "timezone-invalid",
      message: `"${trigger.timezone}" no es una zona horaria IANA válida.`,
    })
  }

  // --- shape --------------------------------------------------------------
  if (nodes.length === 0) {
    push({ level: "error", code: "empty", message: "El flujo está vacío: añade al menos un bloque." })
  }

  const starts = nodes.filter((node) => node.type === "start")
  if (starts.length === 0) {
    push({ level: "error", code: "start-missing", message: "Falta el bloque Start." })
  } else if (starts.length > 1) {
    push({
      level: "error",
      code: "start-duplicated",
      message: `Un flujo tiene un solo Start (hay ${starts.length}).`,
    })
  }

  for (const node of nodes) {
    const catalog = catalogFor(node.type)
    if (!catalog) {
      push({
        level: "error",
        code: "node-type-unknown",
        nodeId: node.id,
        message: `El bloque "${node.type}" no existe.`,
      })
      continue
    }

    if (catalog.kind !== node.kind) {
      push({
        level: "error",
        code: "node-kind-mismatch",
        nodeId: node.id,
        message: `"${catalog.label}" no puede ser de tipo ${node.kind}.`,
      })
    }

    for (const field of catalog.fields) {
      const value = (node.config[field.key] ?? "").trim()
      if (field.required && value === "") {
        push({
          level: "error",
          code: "field-required",
          nodeId: node.id,
          message: `"${node.title}" necesita ${field.label}.`,
        })
      }
    }

    if (node.type === "delay") {
      const seconds = Number(node.config.seconds)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        push({
          level: "error",
          code: "delay-invalid",
          nodeId: node.id,
          message: '"' + node.title + '" necesita una espera en segundos mayor que 0.',
        })
      } else if (seconds > 3600) {
        push({
          level: "warning",
          code: "delay-long",
          nodeId: node.id,
          message: `"${node.title}" espera más de una hora (${seconds} s).`,
        })
      }
    }

    // Credentials: only checked when the caller knows what the server has, so
    // the client can still validate structure offline.
    if (options.availableEnv && catalog.requires) {
      const missing = catalog.requires.filter((name) => !options.availableEnv!.includes(name))
      if (missing.length > 0) {
        push({
          level: "error",
          code: "integration-missing",
          nodeId: node.id,
          message: `"${node.title}" necesita ${missing.join(", ")}, que no está configurado en el servidor.`,
        })
      }
    }
  }

  // --- edges --------------------------------------------------------------
  const edgeIds = new Set<string>()
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      push({ level: "error", code: "edge-duplicated", message: `La conexión ${edge.id} está duplicada.` })
    }
    edgeIds.add(edge.id)

    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      push({
        level: "error",
        code: "edge-dangling",
        message: "Hay una conexión que apunta a un bloque que ya no existe.",
      })
      continue
    }
    if (edge.source === edge.target) {
      push({
        level: "error",
        code: "edge-self",
        message: "Un bloque no puede conectarse consigo mismo.",
      })
    }

    const source = byId.get(edge.source)
    if (source?.type === "condition") {
      if (!edge.sourceHandle) {
        push({
          level: "error",
          code: "condition-branch-missing",
          nodeId: source.id,
          message: `La conexión que sale de "${source.title}" debe ser de la rama sí o de la rama no.`,
        })
      }
    } else if (edge.sourceHandle) {
      push({
        level: "error",
        code: "branch-on-plain-node",
        nodeId: edge.source,
        message: `Solo una condición tiene ramas; "${source?.title ?? edge.source}" no.`,
      })
    }
  }

  if (edges.length === 0 && nodes.length > 1) {
    push({ level: "error", code: "no-edges", message: "Conecta los bloques antes de guardar el flujo." })
  }

  if (nodes.length === 1 && starts.length === 1) {
    push({
      level: "warning",
      code: "only-start",
      message: "El flujo solo tiene el bloque Start, así que no hará nada todavía.",
    })
  }

  // --- cycles -------------------------------------------------------------
  try {
    toposort(edges.map((edge) => [edge.source, edge.target]))
  } catch {
    push({
      level: "error",
      code: "cycle",
      message: "El flujo tiene un ciclo: quita la conexión que vuelve hacia atrás.",
    })
  }

  // --- reachability -------------------------------------------------------
  const startId = starts[0]?.id
  if (startId) {
    const outgoing = new Map<string, string[]>()
    for (const edge of edges) {
      const list = outgoing.get(edge.source) ?? []
      list.push(edge.target)
      outgoing.set(edge.source, list)
    }

    const reachable = new Set<string>([startId])
    const queue = [startId]
    while (queue.length) {
      const current = queue.shift()!
      for (const next of outgoing.get(current) ?? []) {
        if (reachable.has(next)) continue
        reachable.add(next)
        queue.push(next)
      }
    }

    for (const node of nodes) {
      if (node.id === startId) continue
      if (!reachable.has(node.id)) {
        push({
          level: "error",
          code: "unreachable",
          nodeId: node.id,
          message: `"${node.title}" no está conectado al Start, así que nunca se ejecutará.`,
        })
      }
    }

    // A condition with no `false` branch silently does nothing when it is false.
    for (const node of nodes.filter((candidate) => candidate.type === "condition")) {
      const branches = new Set(
        edges.filter((edge) => edge.source === node.id).map((edge) => edge.sourceHandle)
      )
      if (!branches.has("true") || !branches.has("false")) {
        push({
          level: "warning",
          code: "condition-branch-incomplete",
          nodeId: node.id,
          message: `"${node.title}" solo tiene una rama conectada; la otra termina el flujo.`,
        })
      }
    }

    // Placeholders that point at a node that is not upstream will be empty at
    // run time; catching it here is much cheaper than debugging the run.
    for (const node of nodes) {
      const upstream = new Set(ancestorsOf(nodes, edges, node.id))
      for (const value of Object.values(node.config)) {
        for (const place of placeholdersIn(value)) {
          const [first] = place.split(".")
          if (!first) continue
          if (!ids.has(first)) {
            push({
              level: "error",
              code: "reference-missing",
              nodeId: node.id,
              message: `"${node.title}" usa {{ ${place} }} pero ese bloque no existe.`,
            })
          } else if (first !== node.id && !upstream.has(first)) {
            push({
              level: "warning",
              code: "reference-not-upstream",
              nodeId: node.id,
              message: `"${node.title}" usa {{ ${place} }} de un bloque que no va antes en el flujo; llegará vacío.`,
            })
          }
        }
      }
    }
  }

  // --- limits -------------------------------------------------------------
  if (nodes.length > settings.maxSteps) {
    push({
      level: "warning",
      code: "steps-over-limit",
      message: `El flujo tiene ${nodes.length} bloques y el límite por ejecución es ${settings.maxSteps}.`,
    })
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    effects: effectsOf(nodes),
  }
}

/** Validate a payload that has not been trusted yet (a client, the model, a
 *  database row written by an older version). */
export function validateUnknown(
  input: unknown,
  options: { availableEnv?: readonly string[] } = {}
): { definition?: AutomationDefinition; report: ValidationReport } {
  const parsed = parseDefinition(input)
  if (!parsed.ok) {
    const errors: ValidationIssue[] = parsed.issues.map((message) => ({
      level: "error" as const,
      code: "schema",
      message,
    }))
    return {
      report: { ok: false, errors, warnings: [], effects: [] },
    }
  }

  return {
    definition: parsed.definition,
    report: validateDefinition(parsed.definition, options),
  }
}
