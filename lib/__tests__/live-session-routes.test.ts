import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotFoundError } from "@browserbasehq/sdk"

// The two ways of watching a session have different secrets behind them, and
// the same rule: the caller only ever names their own task, the server resolves
// the rest from rows scoped to their user id. A task id from another account is
// "not found", never "forbidden" — the route must not confirm it exists.

const state = vi.hoisted(() => ({
  userId: "user_owner" as string | null,
  task: null as Record<string, unknown> | null,
  debugCalls: [] as string[],
  debugResult: null as unknown,
  debugError: null as unknown,
  pcCalls: [] as unknown[][],
  pcResult: null as unknown,
  pcError: null as unknown,
}))

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ isAuthenticated: Boolean(state.userId), userId: state.userId }),
}))

vi.mock("@/lib/execution-tasks", () => ({
  getExecutionTask: async () => state.task,
}))

vi.mock("@/lib/browserbase", () => ({
  browserbaseClient: () => ({
    sessions: {
      debug: async (id: string) => {
        state.debugCalls.push(id)
        if (state.debugError) throw state.debugError
        return state.debugResult
      },
    },
  }),
}))

vi.mock("@/lib/pc", () => ({
  runPcAction: async (...args: unknown[]) => {
    state.pcCalls.push(args)
    if (state.pcError) throw state.pcError
    return state.pcResult
  },
}))

vi.mock("@sentry/nextjs", () => ({
  getIsolationScope: () => ({ setAttributes: () => {} }),
  logger: { warn: () => {}, info: () => {} },
}))

import { GET as viewer } from "@/app/api/live/session/viewer/route"
import { POST as snapshot } from "@/app/api/live/session/snapshot/route"

/** A task row, as the caller's own database would answer it. */
function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "task_1",
    userId: "user_owner",
    environment: "cloud",
    status: "running",
    browserSessionId: "sess_1",
    ...overrides,
  }
}

function viewerRequest(taskId: string | null = "task_1") {
  const url = new URL("http://localhost/api/live/session/viewer")
  if (taskId) url.searchParams.set("taskId", taskId)
  return viewer(new Request(url))
}

function snapshotRequest(body: unknown) {
  return snapshot(
    new Request("http://localhost/api/live/session/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

beforeEach(() => {
  state.userId = "user_owner"
  state.task = taskRow()
  state.debugCalls = []
  state.debugResult = {
    debuggerUrl: "https://live.browserbase.com/start/debugger",
    debuggerFullscreenUrl: "https://live.browserbase.com/start/fullscreen",
    pages: [],
  }
  state.debugError = null
  state.pcCalls = []
  state.pcResult = null
  state.pcError = null
})

describe("GET /api/live/session/viewer", () => {
  it("rejects a signed-out caller before touching Browserbase", async () => {
    state.userId = null

    const response = await viewerRequest("task_1")

    expect(response.status).toBe(401)
    expect(state.debugCalls).toEqual([])
  })

  it("answers not-found for a task that belongs to someone else", async () => {
    state.task = null

    const response = await viewerRequest("someone_elses_task")

    expect(response.status).toBe(404)
    // Nothing is minted for a foreign task: no live link is ever generated.
    expect(state.debugCalls).toEqual([])
  })

  it("asks for no task at all when the query is empty", async () => {
    const response = await viewerRequest(null)
    expect(response.status).toBe(400)
  })

  it("refuses to watch a local session in the cloud viewer", async () => {
    state.task = taskRow({ environment: "local", browserSessionId: null })

    const response = await viewerRequest("task_1")

    expect(response.status).toBe(409)
    expect(state.debugCalls).toEqual([])
  })

  it("refuses before a browser has been opened", async () => {
    state.task = taskRow({ browserSessionId: null })

    const response = await viewerRequest("task_1")

    expect(response.status).toBe(409)
    expect(state.debugCalls).toEqual([])
  })

  it("issues a short-lived viewer link for the caller's own session", async () => {
    const response = await viewerRequest("task_1")

    expect(response.status).toBe(200)
    expect(state.debugCalls).toEqual(["sess_1"])

    const body = (await response.json()) as {
      ok: boolean
      url: string
      expiresInSeconds: number
    }
    expect(body.ok).toBe(true)
    expect(body.url).toContain("browserbase.com")
    expect(body.expiresInSeconds).toBeLessThanOrEqual(600)
    // The link is never cached: it is short-lived and identifies a live browser.
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("reports a session that ended as gone, not as an outage", async () => {
    state.debugError = new NotFoundError(404, {}, "not found", {} as never)

    const response = await viewerRequest("task_1")

    expect(response.status).toBe(410)
    expect((await response.json()).error).toBe("session_ended")
  })

  it("reports a provider failure without leaking the error text", async () => {
    state.debugError = new Error("invalid api key sk-browserbase-secret")

    const response = await viewerRequest("task_1")

    expect(response.status).toBe(502)
    const text = await response.text()
    expect(text).not.toContain("sk-browserbase-secret")
  })
})

describe("POST /api/live/session/snapshot", () => {
  it("rejects a signed-out caller before queueing anything", async () => {
    state.userId = null

    const response = await snapshotRequest({ taskId: "task_1" })

    expect(response.status).toBe(401)
    // No job is queued, so no local computer is asked for anything.
    expect(state.pcCalls).toEqual([])
  })

  it("answers not-found for another account's task", async () => {
    state.task = null

    const response = await snapshotRequest({ taskId: "someone_elses_task" })

    expect(response.status).toBe(404)
    expect(state.pcCalls).toEqual([])
  })

  it("rejects an empty body", async () => {
    const response = await snapshotRequest({})

    expect(response.status).toBe(400)
    expect(state.pcCalls).toEqual([])
  })

  it("never asks the person's computer for a cloud session", async () => {
    state.task = taskRow({ environment: "cloud" })

    const response = await snapshotRequest({ taskId: "task_1" })

    expect(response.status).toBe(409)
    expect(state.pcCalls).toEqual([])
  })

  it("returns the capture of the browser window, without the data-URL prefix", async () => {
    state.task = taskRow({ environment: "local", browserSessionId: null })
    state.pcResult = { image: "data:image/png;base64,AAAA", url: "https://example.com" }

    const response = await snapshotRequest({ taskId: "task_1" })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      base64: string
      mediaType: string
    }
    expect(body).toMatchObject({ ok: true, base64: "AAAA", mediaType: "image/png" })
    // The agent is addressed for this task's own browser window, never the
    // whole screen.
    expect(state.pcCalls[0]?.[1]).toMatchObject({
      kind: "browser_screenshot",
      sessionKey: "task_1",
    })
  })

  it("turns an offline computer into something the person can act on", async () => {
    state.task = taskRow({ environment: "local", browserSessionId: null })
    state.pcError = new Error(
      "No computer is connected to this account. The person has to install Paradox Desktop Agent."
    )

    const response = await snapshotRequest({ taskId: "task_1" })

    const body = (await response.json()) as { ok: boolean; error: string }
    expect(body).toMatchObject({ ok: false, error: "device_offline" })
  })

  it("distinguishes a paused agent from an offline one", async () => {
    state.task = taskRow({ environment: "local", browserSessionId: null })
    state.pcError = new Error(
      "The person paused their Desktop Agent, so no local action can run until they resume it."
    )

    const response = await snapshotRequest({ taskId: "task_1" })

    const body = (await response.json()) as { ok: boolean; error: string }
    expect(body).toMatchObject({ ok: false, error: "agent_paused" })
  })
})
