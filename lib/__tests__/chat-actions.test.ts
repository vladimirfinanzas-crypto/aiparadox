import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A chat turn is executed by Trigger.dev, not by the web server. When its secret
// key is missing, the SDK's own error reached the browser as "the model did not
// answer" — which is the opposite of the truth, because no model was ever called.
// The action now refuses first, with the variable name in the message.

const sdk = vi.hoisted(() => ({
  startSessionCalls: 0,
  publicTokenCalls: 0,
  authenticated: false,
  userId: null as string | null,
}))

vi.mock("@trigger.dev/sdk/ai", () => ({
  chat: {
    createStartSessionAction: () => async () => {
      sdk.startSessionCalls += 1
      return { id: "session" }
    },
    createLoadTranscriptAction: () => async () => ({ messages: [] }),
  },
  defaultStorage: {},
}))

vi.mock("@trigger.dev/sdk", () => ({
  auth: {
    createPublicToken: async () => {
      sdk.publicTokenCalls += 1
      return "token"
    },
  },
}))

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({
    isAuthenticated: sdk.authenticated,
    userId: sdk.userId,
    has: () => true,
  }),
}))

import { mintChatAccessToken, startChatSession } from "@/actions/chat"

describe("chat actions", () => {
  const original = process.env.TRIGGER_SECRET_KEY

  beforeEach(() => {
    sdk.startSessionCalls = 0
    sdk.publicTokenCalls = 0
    sdk.authenticated = false
    sdk.userId = null
    delete process.env.TRIGGER_SECRET_KEY
  })

  afterEach(() => {
    if (original === undefined) delete process.env.TRIGGER_SECRET_KEY
    else process.env.TRIGGER_SECRET_KEY = original
  })

  it("refuses to start a turn without TRIGGER_SECRET_KEY and names the variable", async () => {
    const failure = await startChatSession({
      chatId: "chat_1",
    } as unknown as Parameters<typeof startChatSession>[0]).catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/TRIGGER_SECRET_KEY is not set/)
    // Actionable: where to set it, and that the model was never reached
    expect((failure as Error).message).toMatch(/Netlify/)
    expect((failure as Error).message).toMatch(/no turn can start/)
    // The guard runs before the SDK does any work
    expect(sdk.startSessionCalls).toBe(0)
  })

  it("refuses to mint an access token for the same reason", async () => {
    const failure = await mintChatAccessToken("chat_1").catch(
      (error: unknown) => error
    )

    expect((failure as Error).message).toMatch(/TRIGGER_SECRET_KEY/)
    expect(sdk.publicTokenCalls).toBe(0)
  })

  it("checks the session before starting anything once it is configured", async () => {
    process.env.TRIGGER_SECRET_KEY = "test-trigger-key"

    const failure = await startChatSession({
      chatId: "chat_1",
    } as unknown as Parameters<typeof startChatSession>[0]).catch(
      (error: unknown) => error
    )

    // Signed out: the ownership lookup refuses before a session exists
    expect((failure as Error).message).toMatch(/Unauthorized/)
    expect(sdk.startSessionCalls).toBe(0)
  })
})
