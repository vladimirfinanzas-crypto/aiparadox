import { describe, expect, it } from "vitest"

import {
  countLiveItems,
  progressPercent,
  relativeTime,
  resourcePathFrom,
  sortLiveItems,
  type LiveItem,
  type LiveStatus,
} from "@/lib/live/view"

function item(id: string, status: LiveStatus, updatedAt: string): LiveItem {
  return {
    id,
    source: "automation",
    title: id,
    detail: "",
    status,
    statusLabel: status,
    updatedAt,
  }
}

describe("live view ordering", () => {
  it("puts what needs a decision first and finished work last", () => {
    const sorted = sortLiveItems([
      item("done", "succeeded", "2026-01-01T10:05:00.000Z"),
      item("running", "running", "2026-01-01T10:00:00.000Z"),
      item("needs-you", "attention", "2026-01-01T09:00:00.000Z"),
      item("queued", "queued", "2026-01-01T10:01:00.000Z"),
      item("waiting", "waiting", "2026-01-01T10:02:00.000Z"),
      item("failed", "failed", "2026-01-01T10:03:00.000Z"),
    ])

    expect(sorted.map((entry) => entry.id)).toEqual([
      "needs-you",
      "running",
      "waiting",
      "queued",
      "failed",
      "done",
    ])
  })

  it("keeps the newest first inside a group", () => {
    const sorted = sortLiveItems([
      item("old", "running", "2026-01-01T08:00:00.000Z"),
      item("new", "running", "2026-01-01T09:00:00.000Z"),
    ])

    expect(sorted.map((entry) => entry.id)).toEqual(["new", "old"])
  })

  it("counts active, attention and failed separately", () => {
    const counts = countLiveItems([
      item("a", "running", "2026-01-01T10:00:00.000Z"),
      item("b", "queued", "2026-01-01T10:00:00.000Z"),
      item("c", "waiting", "2026-01-01T10:00:00.000Z"),
      item("d", "attention", "2026-01-01T10:00:00.000Z"),
      item("e", "failed", "2026-01-01T10:00:00.000Z"),
      item("f", "succeeded", "2026-01-01T10:00:00.000Z"),
    ])

    expect(counts).toEqual({ active: 3, attention: 1, failed: 1 })
  })
})

describe("live view progress", () => {
  it("never invents a percentage", () => {
    expect(progressPercent(undefined)).toBeNull()
    expect(progressPercent({ done: 0, total: 0 })).toBeNull()
  })

  it("reports the real ratio, clamped", () => {
    expect(progressPercent({ done: 2, total: 3 })).toBe(67)
    expect(progressPercent({ done: 5, total: 5 })).toBe(100)
    expect(progressPercent({ done: 9, total: 5 })).toBe(100)
  })
})

describe("live view resources", () => {
  it("reads the resource a tool wrote from its result", () => {
    expect(resourcePathFrom('{"id":"a1","path":"/widgets/gK3n9x"}')).toBe(
      "/widgets/gK3n9x"
    )
    expect(
      resourcePathFrom('{"saved":true,"path":"/workflows/0f8fad5b-d9cb-469f"}')
    ).toBe("/workflows/0f8fad5b-d9cb-469f")
  })

  it("ignores anything that is not a resource path", () => {
    expect(resourcePathFrom(null)).toBeNull()
    expect(resourcePathFrom("done")).toBeNull()
    expect(resourcePathFrom("/settings/integrations")).toBeNull()
  })
})

describe("live view times", () => {
  it("describes how long ago something happened", () => {
    const now = Date.parse("2026-01-01T12:00:00.000Z")
    expect(relativeTime("2026-01-01T11:59:50.000Z", now)).toBe("hace un momento")
    expect(relativeTime("2026-01-01T11:55:00.000Z", now)).toBe("hace 5 min")
    expect(relativeTime("2026-01-01T09:00:00.000Z", now)).toBe("hace 3 h")
    expect(relativeTime("2025-12-30T12:00:00.000Z", now)).toBe("hace 2 d")
  })
})
