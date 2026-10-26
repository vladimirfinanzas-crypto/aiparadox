import { beforeEach, describe, expect, it, vi } from "vitest"

// A Browserbase session id is the only key needed to fetch a recording, and a
// recording can show whatever the session saw. The route must therefore prove
// the caller owns the session before it talks to Browserbase at all — a signed-in
// account is not the same thing as the account that opened the session.

const state = vi.hoisted(() => ({
  userId: "user_owner" as string | null,
  owns: false,
  browserbaseCalls: 0,
}))

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: state.userId, has: () => true }),
}))

vi.mock("@/lib/execution-tasks", () => ({
  userOwnsBrowserSession: async () => state.owns,
}))

vi.mock("@/lib/browserbase", () => ({
  browserbaseClient: () => {
    state.browserbaseCalls += 1
    return {
      sessions: {
        replays: {
          // No pages means "still processing" — the route answers 202
          retrieve: async () => ({ pages: [] }),
          retrievePage: async () => new Response(""),
        },
      },
    }
  },
}))

vi.mock("@sentry/nextjs", () => ({
  getIsolationScope: () => ({ setAttributes: () => {} }),
  logger: { warn: () => {}, info: () => {} },
}))

import { GET } from "@/app/api/replays/[sessionId]/route"

function requestReplay(sessionId: string) {
  return GET(new Request(`http://localhost/api/replays/${sessionId}`), {
    params: Promise.resolve({ sessionId }),
  })
}

describe("GET /api/replays/[sessionId]", () => {
  beforeEach(() => {
    state.userId = "user_owner"
    state.owns = false
    state.browserbaseCalls = 0
  })

  it("rejects a signed-out caller", async () => {
    state.userId = null

    const response = await requestReplay("sess_1")

    expect(response.status).toBe(401)
    expect(state.browserbaseCalls).toBe(0)
  })

  it("answers not-found for a session that belongs to someone else", async () => {
    state.owns = false

    const response = await requestReplay("someone_elses_session")

    // Not 403: the route must not confirm that another account's session exists.
    expect(response.status).toBe(404)
    // Nothing is fetched, so no recording is ever pulled for a foreign session.
    expect(state.browserbaseCalls).toBe(0)
  })

  it("serves the replay when the session is the caller's own", async () => {
    state.owns = true

    const response = await requestReplay("sess_owner")

    expect(state.browserbaseCalls).toBe(1)
    // An empty page list is Browserbase still processing the recording
    expect(response.status).toBe(202)
  })
})
