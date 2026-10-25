import { describe, expect, it } from "vitest"

import {
  AUTOMATION_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  definitionFromGraph,
  definitionToGraph,
  emptyDefinition,
  parseDefinition,
  type AutomationDefinition,
} from "@/lib/automations/definition"
import { evaluateCondition, placeholdersIn, truthy } from "@/lib/automations/expression"
import { validateDefinition, validateUnknown } from "@/lib/automations/validate"

function definition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  const base = emptyDefinition("Informe semanal", "Europe/Madrid")
  return { ...base, ...overrides }
}

function node(id: string, type: string, config: Record<string, string> = {}) {
  const kind =
    type === "start" ? "trigger" : type === "condition" ? "condition" : "action"
  return {
    id,
    type: type as AutomationDefinition["nodes"][number]["type"],
    kind: kind as AutomationDefinition["nodes"][number]["kind"],
    title: id,
    config,
    position: { x: 0, y: 0 },
  }
}

function edge(id: string, source: string, target: string, sourceHandle?: "true" | "false") {
  return { id, source, target, ...(sourceHandle ? { sourceHandle } : {}) }
}

const emailNode = () =>
  node("mail", "send-email", { to: "a@b.c", subject: "Hola", body: "Texto" })

describe("definición", () => {
  it("un flujo nuevo tiene un Start y nada más", () => {
    const def = emptyDefinition("Nueva", "Europe/Madrid")
    expect(def.schemaVersion).toBe(AUTOMATION_SCHEMA_VERSION)
    expect(def.nodes).toHaveLength(1)
    expect(def.nodes[0]?.type).toBe("start")
    expect(def.trigger.kind).toBe("manual")
    expect(def.settings).toEqual(DEFAULT_SETTINGS)
    expect(parseDefinition(def).ok).toBe(true)
  })

  it("rechaza versiones de esquema desconocidas", () => {
    const result = parseDefinition({ ...definition(), schemaVersion: 1 })
    expect(result.ok).toBe(false)
  })

  it("sobrevive a la ida y vuelta con el lienzo", () => {
    const def = definition({
      nodes: [node("start", "start"), emailNode()],
      edges: [edge("e1", "start", "mail")],
    })
    const graph = definitionToGraph(def)
    expect(graph.nodes[1]?.data.type).toBe("send-email")
    expect(graph.nodes[1]?.data.values.to).toBe("a@b.c")

    const back = definitionFromGraph({ name: "Informe semanal", graph })
    expect(back.nodes.map((n) => n.id)).toEqual(["start", "mail"])
    expect(back.edges).toEqual(def.edges)
  })

  it("importa el grafo antiguo sin perder bloques", () => {
    const imported = definitionFromGraph({
      name: "viejo",
      graph: {
        nodes: [
          {
            id: "start",
            type: "step",
            position: { x: 0, y: 0 },
            data: { type: "start", kind: "trigger", title: "Start", values: {} },
          },
        ],
        edges: [],
      },
    })
    expect(imported.nodes).toHaveLength(1)
    expect(imported.trigger.kind).toBe("manual")
  })
})

describe("condiciones", () => {
  const outputs = {
    read: { extraction: "hay un error en la página", count: 3 },
    act: { success: true },
    list: { items: ["a", "b"] },
  }

  it("compara números", () => {
    expect(evaluateCondition("{{ read.count }} > 2", outputs)).toEqual({ ok: true, value: true })
    expect(evaluateCondition("{{ read.count }} <= 2", outputs)).toEqual({ ok: true, value: false })
  })

  it("compara texto y contiene", () => {
    expect(evaluateCondition('{{ read.extraction }} contains "error"', outputs)).toEqual({
      ok: true,
      value: true,
    })
    expect(evaluateCondition('{{ read.extraction }} == "otra cosa"', outputs)).toEqual({
      ok: true,
      value: false,
    })
  })

  it("entiende booleanos, vacíos y listas", () => {
    expect(evaluateCondition("{{ act.success }}", outputs)).toEqual({ ok: true, value: true })
    expect(evaluateCondition("isEmpty({{ nada }})", outputs)).toEqual({ ok: true, value: true })
    expect(evaluateCondition("{{ list.items }} contains b", outputs)).toEqual({
      ok: true,
      value: true,
    })
  })

  it("falla de forma explícita cuando no puede comparar", () => {
    const result = evaluateCondition('{{ read.extraction }} > 3', outputs)
    expect(result.ok).toBe(false)
  })

  it("no evalúa código", () => {
    const result = evaluateCondition("process.exit(1)", {})
    expect(result.ok).toBe(true)
    expect(result).toEqual({ ok: true, value: true })
  })

  it("extrae los placeholders de una expresión", () => {
    expect(placeholdersIn("{{ a.b }} > {{ c }}")).toEqual(["a.b", "c"])
    expect(truthy("false")).toBe(false)
    expect(truthy("0")).toBe(false)
    expect(truthy([])).toBe(false)
  })
})

describe("validación", () => {
  it("acepta un flujo completo", () => {
    const report = validateDefinition(
      definition({
        nodes: [node("start", "start"), emailNode()],
        edges: [edge("e1", "start", "mail")],
      })
    )
    expect(report.errors).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.effects).toContain("envía un correo electrónico")
  })

  it("rechaza un flujo sin Start", () => {
    const report = validateDefinition(
      definition({ nodes: [emailNode()], edges: [] })
    )
    expect(report.errors.map((issue) => issue.code)).toContain("start-missing")
  })

  it("rechaza bloques desconectados y ciclos", () => {
    const unreachable = validateDefinition(
      definition({
        nodes: [node("start", "start"), emailNode()],
        edges: [],
      })
    )
    expect(unreachable.errors.map((issue) => issue.code)).toContain("unreachable")

    const cyclic = validateDefinition(
      definition({
        nodes: [node("start", "start"), node("a", "delay", { seconds: "1" }), node("b", "delay", { seconds: "1" })],
        edges: [edge("e1", "start", "a"), edge("e2", "a", "b"), edge("e3", "b", "a")],
      })
    )
    expect(cyclic.errors.map((issue) => issue.code)).toContain("cycle")
  })

  it("exige los campos obligatorios y una espera válida", () => {
    const report = validateDefinition(
      definition({
        nodes: [
          node("start", "start"),
          node("mail", "send-email", { to: "", subject: "", body: "" }),
          node("wait", "delay", { seconds: "0" }),
        ],
        edges: [edge("e1", "start", "mail"), edge("e2", "start", "wait")],
      })
    )
    const codes = report.errors.map((issue) => issue.code)
    expect(codes).toContain("field-required")
    expect(codes).toContain("delay-invalid")
  })

  it("exige rama sí/no en las condiciones", () => {
    const report = validateDefinition(
      definition({
        nodes: [
          node("start", "start"),
          node("check", "condition", { expression: "{{ start.x }} > 1" }),
          node("a", "delay", { seconds: "1" }),
          node("b", "delay", { seconds: "1" }),
        ],
        edges: [
          edge("e1", "start", "check"),
          edge("e2", "check", "a"),
          edge("e3", "check", "b", "true"),
        ],
      })
    )
    expect(report.errors.map((issue) => issue.code)).toContain("condition-branch-missing")
  })

  it("avisa de referencias que no existen", () => {
    const report = validateDefinition(
      definition({
        nodes: [
          node("start", "start"),
          node("mail", "send-email", { to: "a@b.c", subject: "x", body: "{{ nada.a }}" }),
        ],
        edges: [edge("e1", "start", "mail")],
      })
    )
    expect(report.errors.map((issue) => issue.code)).toContain("reference-missing")
  })

  it("rechaza cron y zona horaria inválidos", () => {
    const report = validateDefinition(
      definition({
        trigger: { kind: "cron", cron: "cada lunes", timezone: "Marte/Olimpo" },
        nodes: [node("start", "start")],
      })
    )
    const codes = report.errors.map((issue) => issue.code)
    expect(codes).toContain("cron-invalid")
    expect(codes).toContain("timezone-invalid")
  })

  it("marca como error una integración sin credenciales cuando el servidor lo sabe", () => {
    const def = definition({
      nodes: [node("start", "start"), emailNode()],
      edges: [edge("e1", "start", "mail")],
    })
    const without = validateDefinition(def, { availableEnv: [] })
    expect(without.errors.map((issue) => issue.code)).toContain("integration-missing")

    const withKey = validateDefinition(def, { availableEnv: ["RESEND_API_KEY"] })
    expect(withKey.ok).toBe(true)
  })

  it("valida también lo que no ha pasado por el esquema", () => {
    const report = validateUnknown({ nope: true })
    expect(report.definition).toBeUndefined()
    expect(report.report.ok).toBe(false)
    expect(report.report.errors[0]?.code).toBe("schema")
  })
})
