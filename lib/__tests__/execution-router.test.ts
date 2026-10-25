import { describe, expect, it } from "vitest"

import {
  CANCEL_OPTION,
  checkResolution,
  decideExecutionRoute,
  detectExplicitEnvironment,
  environmentOptions,
  looksLikeWebTask,
  type EnvironmentAvailability,
} from "@/lib/execution-router"

const BOTH: EnvironmentAvailability = {
  cloud: { available: true },
  local: { available: true },
}

const ONLY_CLOUD: EnvironmentAvailability = {
  cloud: { available: true },
  local: { available: false, reason: "no computer is online" },
}

describe("where a task runs", () => {
  it("asks, and runs nothing, when a scraping request names no environment", () => {
    const decision = decideExecutionRoute({
      request: "Investiga los precios de 30 competidores y organiza una tabla",
      availability: BOTH,
    })

    expect(decision.kind).toBe("ask")
    if (decision.kind !== "ask") return

    expect(decision.question).toBe("¿Dónde quieres ejecutar esta tarea?")
    expect(decision.options.map((option) => option.id)).toEqual([
      "cloud",
      "local",
      "cancel",
    ])
    // Nothing about the decision opens a browser: it only describes the choice.
    expect(Object.keys(decision)).not.toContain("run")
  })

  it("uses Browserbase when the person asked for it", () => {
    const decision = decideExecutionRoute({
      request: "Haz el scraping utilizando Browserbase",
      availability: BOTH,
    })

    expect(decision).toEqual({
      kind: "run",
      environment: "cloud",
      reason: "The person asked for cloud.",
    })
  })

  it("uses the person's own computer when they said so", () => {
    const decision = decideExecutionRoute({
      request: "Abre Chrome en mi computadora y busca tutoriales de matemáticas",
      availability: BOTH,
    })

    expect(decision.kind).toBe("run")
    if (decision.kind === "run") expect(decision.environment).toBe("local")
  })

  it("never switches environments silently when the chosen one is unavailable", () => {
    const decision = decideExecutionRoute({
      request: "Extrae los precios con mi PC",
      availability: ONLY_CLOUD,
    })

    expect(decision.kind).toBe("blocked")
    if (decision.kind !== "blocked") return
    expect(decision.environment).toBe("local")
    expect(decision.reason).toContain("no computer is online")
  })

  it("does not ask for a browser when an authorized API returns the data", () => {
    const decision = decideExecutionRoute({
      request: "Obtén los datos de mis publicaciones de Instagram",
      apiResolvable: true,
      availability: BOTH,
    })

    expect(decision.kind).toBe("api")
  })

  it("asks nothing when the request needs no browser at all", () => {
    const decision = decideExecutionRoute({
      request: "Resume este texto en tres líneas",
      availability: BOTH,
    })

    expect(decision.kind).toBe("direct")
  })

  it("does not ask again when the person already chose in this conversation", () => {
    const decision = decideExecutionRoute({
      request: "Sigue con la investigación en el navegador cloud",
      availability: BOTH,
    })

    expect(decision.kind).toBe("run")
    if (decision.kind === "run") expect(decision.environment).toBe("cloud")
  })

  it("disables the option that cannot run and keeps Cancelar enabled", () => {
    const options = environmentOptions(ONLY_CLOUD)
    const local = options.find((option) => option.id === "local")
    const cancel = options.find((option) => option.id === "cancel")

    expect(local?.disabled).toBe(true)
    expect(cancel).toEqual(CANCEL_OPTION)
    expect(cancel?.disabled).toBeFalsy()
  })
})

describe("reading the environment from the person's words", () => {
  it("recognises both environments in Spanish and English", () => {
    expect(detectExplicitEnvironment("usa browserbase")).toBe("cloud")
    expect(detectExplicitEnvironment("en el navegador de mi PC")).toBe("local")
    expect(detectExplicitEnvironment("my computer, please")).toBe("local")
    expect(detectExplicitEnvironment("en la nube")).toBe("cloud")
    expect(detectExplicitEnvironment("hazme un resumen")).toBeUndefined()
  })

  it("prefers the local machine when both are named", () => {
    expect(
      detectExplicitEnvironment("no en la nube: en mi PC, con mi Chrome")
    ).toBe("local")
  })

  it("spots web work without matching ordinary conversation", () => {
    expect(looksLikeWebTask("extrae los precios de estas tiendas")).toBe(true)
    expect(looksLikeWebTask("https://example.com")).toBe(true)
    expect(looksLikeWebTask("explícame la teoría de cuerdas")).toBe(false)
  })
})

describe("answering the question", () => {
  const pending = {
    userId: "user_1",
    status: "awaiting_execution_environment",
    environment: null,
  }

  it("rejects a click from another account before revealing any state", () => {
    const check = checkResolution({
      task: { ...pending, userId: "someone_else" },
      requesterId: "user_1",
      choice: "cloud",
      availability: BOTH,
    })

    expect(check).toEqual({
      ok: false,
      code: "not_owner",
      message: "Task not found",
    })
  })

  it("treats a second click as already answered instead of a new task", () => {
    const check = checkResolution({
      task: { userId: "user_1", status: "queued", environment: "cloud" },
      requesterId: "user_1",
      choice: "cloud",
      availability: BOTH,
    })

    expect(check).toEqual({
      ok: true,
      choice: "cloud",
      duplicate: true,
      environment: "cloud",
    })
  })

  it("cancels a pending task without choosing anything", () => {
    const check = checkResolution({
      task: pending,
      requesterId: "user_1",
      choice: "cancel",
      availability: BOTH,
    })

    expect(check).toEqual({ ok: true, choice: "cancel", duplicate: false })
  })

  it("refuses an environment that cannot run, with the reason", () => {
    const check = checkResolution({
      task: pending,
      requesterId: "user_1",
      choice: "local",
      availability: ONLY_CLOUD,
    })

    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.code).toBe("unavailable")
    expect(check.message).toContain("no computer is online")
  })

  it("refuses to answer a task that is already over", () => {
    const check = checkResolution({
      task: { userId: "user_1", status: "cancelled", environment: null },
      requesterId: "user_1",
      choice: "cloud",
      availability: BOTH,
    })

    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.code).toBe("not_pending")
  })
})
