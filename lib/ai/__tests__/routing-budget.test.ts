import { describe, expect, it } from "vitest"

import { ROUTING_DEADLINE_MS } from "@/lib/agent-router"

import { ROLE_DEADLINES } from "../models"
import { MODEL_ROLES } from "../types"

// The bug this pins down: the routing call is given 4.5s as a whole
// (`pickAgent`), but the evaluator rungs were 6s, 8s and 8s. The outer signal
// therefore aborted the ladder during its FIRST attempt, so the second and third
// rungs never ran — agent routing could only ever succeed on a very fast
// primary, and every other turn silently fell back to the orchestrator.
describe("role deadlines", () => {
  it("keeps the evaluator ladder inside the routing budget", () => {
    const total = ROLE_DEADLINES.evaluator.reduce((sum, ms) => sum + ms, 0)

    expect(total).toBeLessThan(ROUTING_DEADLINE_MS)
  })

  it("leaves room for one retry backoff inside that budget", () => {
    const total = ROLE_DEADLINES.evaluator.reduce((sum, ms) => sum + ms, 0)

    // 300ms is the first backoff (lib/ai/fallback.ts, baseMs)
    expect(ROUTING_DEADLINE_MS - total).toBeGreaterThanOrEqual(300)
  })

  it("gives every role a usable deadline", () => {
    for (const role of MODEL_ROLES) {
      const rungs = ROLE_DEADLINES[role]
      expect(rungs.length).toBeGreaterThan(0)
      for (const ms of rungs) {
        expect(ms).toBeGreaterThan(0)
        expect(Number.isFinite(ms)).toBe(true)
      }
    }
  })
})
