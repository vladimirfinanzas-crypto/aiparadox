import toposort from "toposort"

import type { AutomationNodeType } from "@/lib/automations/catalog"
import type {
  AutomationDefinition,
  AutomationNode,
  AutomationSettings,
} from "@/lib/automations/definition"
import { evaluateCondition } from "@/lib/automations/expression"
import { interpolate, type NodeOutputs } from "@/features/workflows/lib/interpolate"

// The engine walks a definition and calls an executor per block.
//
// It is pure with respect to the outside world: it does not touch the database,
// does not open browsers and does not read the clock beyond an injected `now`.
// Everything it needs — the executors, the durable wait, the progress callbacks
// — arrives in the context. That is what makes it testable, and what lets the
// Trigger.dev task own persistence while the branching rules live here.

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped"

export type EngineStep = {
  nodeId: string
  type: AutomationNodeType
  title: string
  status: StepStatus
  attempt: number
  output?: unknown
  error?: string
  durationMs?: number
}

export type ExecutorContext = {
  values: Record<string, string>
  outputs: NodeOutputs
  nodeId: string
}

export type EngineExecutor = (ctx: ExecutorContext) => Promise<unknown>

export type EngineHooks = {
  /** Fires once with the full plan, before anything runs. */
  onPlan?: (steps: EngineStep[]) => Promise<void> | void
  /** Fires whenever a step changes state. */
  onStep?: (step: EngineStep) => Promise<void> | void
  /** A durable wait. Trigger.dev passes `wait.for`; tests pass a timer. */
  wait?: (ms: number) => Promise<void>
  /** Called before every step, so the caller can abort a run mid-flight. */
  shouldContinue?: () => boolean
}

export type EngineResult = {
  status: "succeeded" | "failed" | "cancelled"
  steps: EngineStep[]
  outputs: NodeOutputs
  error?: string
  durationMs: number
}

export type EngineInput = {
  definition: AutomationDefinition
  executors: Partial<Record<AutomationNodeType, EngineExecutor>>
  hooks?: EngineHooks
  outputs?: NodeOutputs
  now?: () => number
}

/** The nodes that can be reached from Start at all, following every edge. */
function reachableFromStart(definition: AutomationDefinition): Set<string> {
  const outgoing = new Map<string, string[]>()
  for (const edge of definition.edges) {
    const list = outgoing.get(edge.source) ?? []
    list.push(edge.target)
    outgoing.set(edge.source, list)
  }

  const start = definition.nodes.find((node) => node.type === "start")
  const seen = new Set<string>()
  if (!start) return seen

  seen.add(start.id)
  const queue = [start.id]
  while (queue.length) {
    const current = queue.shift()!
    for (const next of outgoing.get(current) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

/** Deterministic execution order. Validation already rejects cycles; a run
 *  should still not explode if one slipped through, so the order falls back to
 *  declaration order. */
export function planOf(definition: AutomationDefinition): AutomationNode[] {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]))
  const reachable = reachableFromStart(definition)

  let order: string[]
  try {
    order = toposort
      .array(
        definition.nodes.map((node) => node.id),
        definition.edges.map((edge) => [edge.source, edge.target] as [string, string])
      )
      .filter((id) => reachable.has(id))
  } catch {
    order = definition.nodes.map((node) => node.id).filter((id) => reachable.has(id))
  }

  // Nodes with no incoming edge at all still belong to the plan if declared
  // (validation flags them separately), so the console is never missing a row.
  return order.flatMap((id) => {
    const node = byId.get(id)
    return node ? [node] : []
  })
}

/** Outputs are stored so the console can show what each block produced, but a
 *  single block must not be able to grow the run row without bound. */
export function trimOutput(value: unknown, limit = 8_000): unknown {
  if (value == null) return value
  try {
    const text = JSON.stringify(value)
    if (!text) return value
    if (text.length <= limit) return value
    return { truncated: true, preview: text.slice(0, limit) }
  } catch {
    return { truncated: true, preview: String(value).slice(0, limit) }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return "Error desconocido"
  }
}

const defaultWait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

export async function runAutomation({
  definition,
  executors,
  hooks = {},
  outputs: seed = {},
  now = Date.now,
}: EngineInput): Promise<EngineResult> {
  const settings: AutomationSettings = definition.settings
  const wait = hooks.wait ?? defaultWait
  const startedAt = now()
  const outputs: NodeOutputs = { ...seed }

  const plan = planOf(definition)
  const steps: EngineStep[] = plan.map((node) => ({
    nodeId: node.id,
    type: node.type,
    title: node.title,
    status: "pending",
    attempt: 0,
  }))
  const stepOf = new Map(steps.map((step) => [step.nodeId, step]))

  await hooks.onPlan?.(steps)

  const reachable = reachableFromStart(definition)
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const edge of definition.edges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source])
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  }

  const startId = definition.nodes.find((node) => node.type === "start")?.id
  const activatedEdges = new Set<string>()
  const edgeKey = (edgeId: string) => edgeId

  const publish = async (step: EngineStep) => {
    await hooks.onStep?.({ ...step })
  }

  let executed = 0
  let failed = false
  let failureMessage: string | undefined

  const cancel = (): EngineResult => {
    for (const step of steps) {
      if (step.status === "pending" || step.status === "running") step.status = "skipped"
    }
    return {
      status: "cancelled",
      steps,
      outputs,
      error: "Ejecución cancelada.",
      durationMs: now() - startedAt,
    }
  }

  for (const node of plan) {
    if (hooks.shouldContinue && !hooks.shouldContinue()) return cancel()

    const step = stepOf.get(node.id)!

    // Start always runs. Any other node runs only if an activated edge reaches
    // it, which is how a condition's untaken branch is skipped.
    const inbound = incoming.get(node.id) ?? []
    const isStart = node.id === startId
    const activated = isStart || inbound.some((source) => activatedFor(source, node.id))

    if (!activated) {
      if (reachable.has(node.id)) {
        step.status = "skipped"
        await publish(step)
      }
      continue
    }

    if (now() - startedAt > settings.timeoutMs) {
      failureMessage = `La ejecución superó el límite de ${Math.round(settings.timeoutMs / 1000)} s.`
      failed = true
      break
    }

    if (executed >= settings.maxSteps) {
      failureMessage = `La ejecución llegó al límite de ${settings.maxSteps} pasos.`
      failed = true
      break
    }
    executed += 1

    // The Start block only opens the flow; it produces nothing.
    if (node.type === "start") {
      step.status = "done"
      step.attempt = 1
      step.durationMs = 0
      await publish(step)
      for (const edge of definition.edges.filter((candidate) => candidate.source === node.id)) {
        activatedEdges.add(edgeKey(edge.id))
      }
      continue
    }

    if (node.type === "condition") {
      // The raw expression is evaluated against the typed outputs: a condition
      // compares values, it does not read the interpolated text.
      const evaluated = evaluateCondition(node.config.expression ?? "", outputs)
      const result = evaluated.ok ? evaluated.value : false

      step.attempt = 1
      step.status = "done"
      step.durationMs = 0
      step.output = { result, ...(evaluated.ok ? {} : { error: evaluated.error }) }
      outputs[node.id] = step.output
      await publish(step)

      if (!evaluated.ok) {
        // An unreadable condition is a broken flow, not a silent `false`.
        step.status = "failed"
        step.error = evaluated.error
        await publish(step)
        failed = true
        failureMessage = `"${node.title}": ${evaluated.error}`
        if (settings.onError === "stop") break
        continue
      }

      for (const edge of definition.edges.filter((candidate) => candidate.source === node.id)) {
        if (edge.sourceHandle === (result ? "true" : "false")) {
          activatedEdges.add(edgeKey(edge.id))
        }
      }
      continue
    }

    if (node.type === "delay") {
      const seconds = Number(interpolate({ text: node.config.seconds ?? "0", outputs }))
      if (!Number.isFinite(seconds) || seconds <= 0) {
        step.status = "failed"
        step.attempt = 1
        step.error = `"${node.title}" necesita una espera mayor que 0 segundos.`
        await publish(step)
        failed = true
        failureMessage = step.error
        if (settings.onError === "stop") break
        continue
      }

      step.attempt = 1
      step.status = "running"
      await publish(step)
      const stepStarted = now()
      // A durable wait, not a timer in this process: the Trigger.dev task can
      // sleep for hours and resume exactly here.
      await wait(Math.min(seconds, 3_600) * 1000)
      step.status = "done"
      step.durationMs = now() - stepStarted
      step.output = { waitedSeconds: seconds }
      outputs[node.id] = step.output
      await publish(step)

      for (const edge of definition.edges.filter((candidate) => candidate.source === node.id)) {
        activatedEdges.add(edgeKey(edge.id))
      }
      continue
    }

    const executor = executors[node.type]
    if (!executor) {
      step.status = "failed"
      step.attempt = 1
      step.error = `El bloque "${node.type}" no tiene ejecutor.`
      await publish(step)
      failed = true
      failureMessage = step.error
      if (settings.onError === "stop") break
      continue
    }

    const values = Object.fromEntries(
      Object.entries(node.config).map(([key, text]) => [key, interpolate({ text, outputs })])
    )

    const attempts = settings.retries + 1
    let lastError: string | undefined

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (hooks.shouldContinue && !hooks.shouldContinue()) return cancel()

      step.attempt = attempt
      step.status = "running"
      step.error = undefined
      await publish(step)

      const stepStarted = now()
      try {
        const output = trimOutput(
          await executor({ values, outputs, nodeId: node.id })
        )
        step.status = "done"
        step.durationMs = now() - stepStarted
        step.output = output
        outputs[node.id] = output
        await publish(step)
        lastError = undefined
        break
      } catch (error) {
        lastError = describeError(error)
        step.status = "failed"
        step.durationMs = now() - stepStarted
        step.error = lastError
        await publish(step)
      }
    }

    if (lastError) {
      failed = true
      failureMessage = `"${node.title}": ${lastError}`
      if (settings.onError === "stop") break
      // Continuing past a failure is a deliberate choice, so the flow keeps
      // moving: the block produced nothing, and downstream steps see an empty
      // placeholder rather than a silently abandoned run.
    }

    for (const edge of definition.edges.filter((candidate) => candidate.source === node.id)) {
      activatedEdges.add(edgeKey(edge.id))
    }
  }

  if (hooks.shouldContinue && !hooks.shouldContinue()) return cancel()

  return {
    status: failed ? "failed" : "succeeded",
    steps,
    outputs,
    ...(failed && failureMessage ? { error: failureMessage } : {}),
    durationMs: now() - startedAt,
  }

  function activatedFor(source: string, target: string): boolean {
    return definition.edges.some(
      (edge) =>
        edge.source === source &&
        edge.target === target &&
        activatedEdges.has(edgeKey(edge.id))
    )
  }
}
