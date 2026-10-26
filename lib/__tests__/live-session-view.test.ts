import { describe, expect, it } from "vitest"

// The session viewport is only honest if its states are derived from rows that
// exist: a task's status, its environment and whether the person's computer is
// answering. These tests pin that mapping.

import {
  buildLiveSessionView,
  canWatchSession,
  emptyLiveSessionView,
  isNewerSessionView,
  lastStepLabel,
  sessionStatus,
  sessionStatusLabels,
  type DeviceSummary,
} from "@/lib/live/session"

const device: DeviceSummary = { total: 1, online: 1, paused: false }
const offline: DeviceSummary = { total: 1, online: 0, paused: false }
const paused: DeviceSummary = { total: 1, online: 0, paused: true }

const task = {
  id: "task_1",
  environment: "cloud" as const,
  status: "running" as const,
  request: "Comprueba mis pedidos",
  error: null,
  events: [],
  conversationId: "conv_1",
  browserSessionId: "sess_1",
  createdAt: new Date("2026-01-01T10:00:00Z"),
  startedAt: new Date("2026-01-01T10:00:05Z"),
  completedAt: null,
}

describe("sessionStatus", () => {
  it("is connecting while the task is queued", () => {
    expect(
      sessionStatus({ environment: "cloud", taskStatus: "queued", device })
    ).toBe("connecting")
  })

  it("is active for a cloud session, whatever the computer is doing", () => {
    expect(
      sessionStatus({ environment: "cloud", taskStatus: "running", device: offline })
    ).toBe("active")
  })

  it("is active for a local session whose computer is answering", () => {
    expect(
      sessionStatus({ environment: "local", taskStatus: "running", device })
    ).toBe("active")
  })

  it("is paused when the person paused their Desktop Agent", () => {
    expect(
      sessionStatus({ environment: "local", taskStatus: "running", device: paused })
    ).toBe("paused")
  })

  it("is disconnected when the computer stopped answering", () => {
    expect(
      sessionStatus({ environment: "local", taskStatus: "running", device: offline })
    ).toBe("disconnected")
  })

  it("is finished once the task ends, and error when it fails", () => {
    expect(
      sessionStatus({ environment: "cloud", taskStatus: "completed", device })
    ).toBe("finished")
    expect(
      sessionStatus({ environment: "cloud", taskStatus: "failed", device })
    ).toBe("error")
  })

  it("covers every state the panel offers a label for", () => {
    const statuses = [
      "none",
      "connecting",
      "active",
      "paused",
      "disconnected",
      "finished",
      "error",
    ] as const
    expect(Object.keys(sessionStatusLabels).sort()).toEqual([...statuses].sort())
  })
})

describe("lastStepLabel", () => {
  it("describes the newest step, not the oldest", () => {
    const label = lastStepLabel([
      { at: "2026-01-01T10:00:00Z", kind: "step", tool: "browser_navigate" },
      { at: "2026-01-01T10:00:09Z", kind: "step", tool: "browser_click" },
      { at: "2026-01-01T10:00:04Z", kind: "step", tool: "browser_read" },
    ])
    expect(label).toBe("hizo clic")
  })

  it("says when the last thing was a failure", () => {
    expect(
      lastStepLabel([{ at: "2026-01-01T10:00:00Z", kind: "error", tool: "browser_click" }])
    ).toBe("falló hizo clic")
  })

  it("has nothing to say for an empty trail", () => {
    expect(lastStepLabel([])).toBeNull()
  })
})

describe("canWatchSession", () => {
  it("offers a live viewer only for a running cloud session with an id", () => {
    expect(
      canWatchSession("cloud", { browserSessionId: "sess_1", status: "running" }, device)
    ).toEqual({ canViewLive: true, canCapture: false })
  })

  it("does not offer a live viewer once the session has ended", () => {
    expect(
      canWatchSession("cloud", { browserSessionId: "sess_1", status: "completed" }, device)
    ).toEqual({ canViewLive: false, canCapture: false })
  })

  it("never offers a live viewer for a local session", () => {
    expect(
      canWatchSession("local", { browserSessionId: null, status: "running" }, device)
    ).toEqual({ canViewLive: false, canCapture: true })
  })

  it("does not ask a disconnected computer for captures", () => {
    expect(
      canWatchSession("local", { browserSessionId: null, status: "running" }, offline)
    ).toEqual({ canViewLive: false, canCapture: false })
  })
})

describe("buildLiveSessionView", () => {
  it("reports the environment and the activity the task recorded", () => {
    const view = buildLiveSessionView({
      task: {
        ...task,
        events: [
          { at: "2026-01-01T10:00:00Z", kind: "session_opened", detail: "cloud" },
          { at: "2026-01-01T10:00:02Z", kind: "step", tool: "browser_navigate" },
          { at: "2026-01-01T10:00:04Z", kind: "step", tool: "browser_read" },
        ],
      },
      device,
      now: Date.parse("2026-01-01T10:00:06Z"),
    })

    expect(view.hasSession).toBe(true)
    expect(view.environment).toBe("cloud")
    expect(view.status).toBe("active")
    expect(view.stepCount).toBe(2)
    expect(view.lastStepLabel).toBe("leyó la página")
    expect(view.canViewLive).toBe(true)
    expect(view.request).toBe("Comprueba mis pedidos")
  })

  it("keeps a long request out of the payload", () => {
    const view = buildLiveSessionView({
      task: { ...task, request: "x".repeat(500) },
      device,
    })
    expect(view.request.length).toBeLessThanOrEqual(160)
  })

  it("never puts an error longer than a toast into the payload", () => {
    const view = buildLiveSessionView({
      task: { ...task, error: "e".repeat(4_000) },
      device,
    })
    expect(view.error?.length).toBeLessThanOrEqual(300)
  })
})

describe("emptyLiveSessionView", () => {
  it("tells the panel there is no viewport to draw", () => {
    const view = emptyLiveSessionView(device, true)
    expect(view.hasSession).toBe(false)
    expect(view.canViewLive).toBe(false)
    expect(view.canCapture).toBe(false)
    // A question waiting for the person is not a session, but the panel must be
    // able to explain why there is nothing on screen.
    expect(view.pendingEnvironment).toBe(true)
  })

  it("refuses to be overwritten by an older snapshot", () => {
    expect(
      isNewerSessionView({ generatedAt: "2026-01-01T10:00:06Z" }, { generatedAt: "2026-01-01T10:00:05Z" })
    ).toBe(true)
    expect(
      isNewerSessionView({ generatedAt: "2026-01-01T10:00:04Z" }, { generatedAt: "2026-01-01T10:00:05Z" })
    ).toBe(false)
  })
})
