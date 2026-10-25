import { describe, expect, it, vi } from "vitest"

import { runAutomation, planOf, trimOutput, type EngineExecutor } from "@/lib/automations/engine"
import {
  emptyDefinition,
  type AutomationDefinition,
  type AutomationNode,
} from "@/lib/automations/definition"

function node(
  id: string,
  type: string,
  config: Record<string, string> = {}
): AutomationNode {
  const kind =
    type === "start" ? "trigger" : type === "condition" ? "condition" : "action"
  return {
    id,
    type: type as AutomationNode["type"],
    kind: kind as AutomationNode["kind"],
    title: id,
    config,
    position: { x: 0, y: 0 },
  }
}

function definition(
  nodes: AutomationNode[],
  edges: AutomationDefinition["edges"],
  settings: Partial<AutomationDefinition["settings"]> = {}
): AutomationDefinition {
  const base = emptyDefinition("Prueba")
  return { ...base, nodes, edges, settings: { ...base.settings, ...settings } }
}

function edge(id: string, source: string, target: string, sourceHandle?: "true" | "false") {
  return { id, source, target, ...(sourceHandle ? { sourceHandle } : {}) }
}

const fakeWait = () => vi.fn(async () => {})

describe("motor", () => {
  it("ejecuta en orden y pasa la salida de un paso al siguiente", async () => {
    const calls: string[] = []
    const executors = {
      extract: (async () => ({ extraction: "42" })) as EngineExecutor,
      "send-email": (async ({ values }) => {
        calls.push(`mail:${values.body}`)
        return { id: "em_1" }
      }) as EngineExecutor,
    }

    const result = await runAutomation({
      definition: definition(
        [
          node("start", "start"),
          node("read", "extract", { instruction: "lee" }),
          node("mail", "send-email", { to: "a@b.c", subject: "s", body: "{{ read.extraction }}" }),
        ],
        [edge("e1", "start", "read"), edge("e2", "read", "mail")],
        { retries: 0 }
      ),
      executors,
    })

    expect(result.status).toBe("succeeded")
    expect(result.steps.map((step) => step.status)).toEqual(["done", "done", "done"])
    expect(calls).toEqual(["mail:42"])
    expect(result.steps[2]?.output).toEqual({ id: "em_1" })
  })

  it("solo recorre la rama de la condición que se cumple", async () => {
    const ran: string[] = []
    const executors = {
      extract: (async ({ nodeId }) => {
        ran.push(nodeId)
        return { seen: nodeId }
      }) as EngineExecutor,
    }

    const result = await runAutomation({
      definition: definition(
        [
          node("start", "start"),
          node("check", "condition", { expression: "{{ start.value }} == true" }),
          node("yes", "extract", { instruction: "lee" }),
          node("no", "extract", { instruction: "lee" }),
        ],
        [
          edge("e1", "start", "check"),
          edge("e2", "check", "yes", "true"),
          edge("e3", "check", "no", "false"),
        ]
      ),
      executors,
      outputs: { start: { value: false } },
    })

    expect(ran).toEqual(["no"])
    const statuses = Object.fromEntries(result.steps.map((step) => [step.nodeId, step.status]))
    expect(statuses.yes).toBe("skipped")
    expect(statuses.no).toBe("done")
    expect(result.status).toBe("succeeded")
  })

  it("espera de forma inyectable, sin temporizadores reales", async () => {
    const wait = fakeWait()
    const result = await runAutomation({
      definition: definition(
        [node("start", "start"), node("pause", "delay", { seconds: "90" })],
        [edge("e1", "start", "pause")]
      ),
      executors: {},
      hooks: { wait },
    })

    expect(wait).toHaveBeenCalledWith(90_000)
    expect(result.status).toBe("succeeded")
    expect(result.steps[1]?.output).toEqual({ waitedSeconds: 90 })
  })

  it("reintenta por paso y registra el intento", async () => {
    let attempts = 0
    const executors = {
      "send-email": (async () => {
        attempts += 1
        if (attempts < 3) throw new Error("SMTP ocupado")
        return { id: "em_ok" }
      }) as EngineExecutor,
    }

    const result = await runAutomation({
      definition: definition(
        [
          node("start", "start"),
          node("mail", "send-email", { to: "a@b.c", subject: "s", body: "b" }),
        ],
        [edge("e1", "start", "mail")],
        { retries: 2 }
      ),
      executors,
    })

    expect(attempts).toBe(3)
    expect(result.status).toBe("succeeded")
    expect(result.steps[1]?.attempt).toBe(3)
    expect(result.steps[1]?.error).toBeUndefined()
  })

  it("se detiene en el primer fallo con onError=stop", async () => {
    const executors = {
      "send-email": (async () => {
        throw new Error("sin destinatario")
      }) as EngineExecutor,
      delay: (async () => ({})) as unknown as EngineExecutor,
    }

    const result = await runAutomation({
      definition: definition(
        [
          node("start", "start"),
          node("mail", "send-email", { to: "a@b.c", subject: "s", body: "b" }),
          node("after", "delay", { seconds: "1" }),
        ],
        [edge("e1", "start", "mail"), edge("e2", "mail", "after")],
        { onError: "stop" }
      ),
      executors,
    })

    expect(result.status).toBe("failed")
    expect(result.error).toContain("sin destinatario")
    const after = result.steps.find((step) => step.nodeId === "after")
    expect(after?.status).toBe("pending")
  })

  it("continúa con onError=continue", async () => {
    const executors = {
      "send-email": (async () => {
        throw new Error("boom")
      }) as EngineExecutor,
      extract: (async () => ({ ok: true })) as EngineExecutor,
    }

    const result = await runAutomation({
      definition: definition(
        [
          node("start", "start"),
          node("mail", "send-email", { to: "a@b.c", subject: "s", body: "b" }),
          node("after", "extract", { instruction: "lee" }),
        ],
        [edge("e1", "start", "mail"), edge("e2", "mail", "after")],
        { onError: "continue" }
      ),
      executors,
    })

    expect(result.status).toBe("failed")
    expect(result.steps.find((step) => step.nodeId === "after")?.status).toBe("done")
  })

  it("respeta el límite de pasos", async () => {
    const executors = {
      delay: (async () => ({})) as unknown as EngineExecutor,
    }
    const result = await runAutomation({
      definition: definition(
        [
          node("start", "start"),
          node("a", "delay", { seconds: "1" }),
          node("b", "delay", { seconds: "1" }),
          node("c", "delay", { seconds: "1" }),
        ],
        [edge("e1", "start", "a"), edge("e2", "a", "b"), edge("e3", "b", "c")],
        { maxSteps: 2 }
      ),
      executors,
    })

    expect(result.status).toBe("failed")
    expect(result.error).toContain("límite de 2 pasos")
  })

  it("se puede cancelar entre pasos", async () => {
    let allowed = true
    const executors = {
      extract: (async () => {
        allowed = false
        return { ok: true }
      }) as EngineExecutor,
    }

    const result = await runAutomation({
      definition: definition(
        [
          node("start", "start"),
          node("a", "extract", { instruction: "lee" }),
          node("b", "extract", { instruction: "lee" }),
        ],
        [edge("e1", "start", "a"), edge("e2", "a", "b")]
      ),
      executors,
      hooks: { shouldContinue: () => allowed },
    })

    expect(result.status).toBe("cancelled")
  })

  it("publica el plan antes de ejecutar", async () => {
    const plan: string[][] = []
    await runAutomation({
      definition: definition([node("start", "start")], []),
      executors: {},
      hooks: {
        onPlan: (steps) => {
          plan.push(steps.map((step) => step.nodeId))
        },
      },
    })
    expect(plan).toEqual([["start"]])
  })

  it("ordena los bloques con toposort y descarta lo inalcanzable", () => {
    const def = definition(
      [
        node("start", "start"),
        node("b", "delay", { seconds: "1" }),
        node("a", "delay", { seconds: "1" }),
        node("isla", "delay", { seconds: "1" }),
      ],
      [edge("e1", "start", "b"), edge("e2", "b", "a")]
    )
    expect(planOf(def).map((item) => item.id)).toEqual(["start", "b", "a"])
  })

  it("trunca salidas enormes antes de guardarlas", () => {
    const trimmed = trimOutput({ blob: "x".repeat(20_000) }, 100) as {
      truncated: boolean
      preview: string
    }
    expect(trimmed.truncated).toBe(true)
    expect(trimmed.preview.length).toBe(100)
  })
})
