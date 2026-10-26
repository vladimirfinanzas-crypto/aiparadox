import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createThrottle } from "@/lib/throttle"

describe("createThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("allows one hit per key per window", () => {
    const throttle = createThrottle({ windowMs: 5_000 })

    expect(throttle.allow("203.0.113.7")).toBe(true)
    expect(throttle.allow("203.0.113.7")).toBe(false)

    vi.advanceTimersByTime(4_999)
    expect(throttle.allow("203.0.113.7")).toBe(false)

    vi.advanceTimersByTime(1)
    expect(throttle.allow("203.0.113.7")).toBe(true)
  })

  it("keeps different clients independent", () => {
    const throttle = createThrottle({ windowMs: 5_000 })

    expect(throttle.allow("a")).toBe(true)
    expect(throttle.allow("b")).toBe(true)
    expect(throttle.allow("a")).toBe(false)
    expect(throttle.allow("b")).toBe(false)
  })

  it("never tracks more keys than its cap", () => {
    const throttle = createThrottle({ windowMs: 60_000, maxEntries: 10 })

    for (let index = 0; index < 500; index += 1) {
      throttle.allow(`client-${index}`)
    }

    expect(throttle.size()).toBeLessThanOrEqual(10)
  })

  it("drops expired keys before dropping live ones", () => {
    const throttle = createThrottle({ windowMs: 1_000, maxEntries: 2 })

    expect(throttle.allow("old-1")).toBe(true)
    expect(throttle.allow("old-2")).toBe(true)

    vi.advanceTimersByTime(1_000)

    // Room comes from the expired pair, so neither new key evicts the other
    expect(throttle.allow("new-1")).toBe(true)
    expect(throttle.allow("new-2")).toBe(true)
    expect(throttle.size()).toBe(2)
  })
})
