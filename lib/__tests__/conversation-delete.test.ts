import { beforeEach, describe, expect, it, vi } from "vitest"

// Deleting a conversation is one click away from losing someone's chat, so
// every branch of the action is pinned here without a database: who may call
// it, what reaches the query, what the person is told when it fails, and that
// a failure never turns into a success on screen.

const state = vi.hoisted(() => ({
  authenticated: false,
  userId: null as string | null,
  // What the query was called with, if it was called at all
  deletedWith: null as { userId: string; chatId: string } | null,
  // What the query answers: a row for success, null for "not yours / gone"
  queryResult: null as { id: string; kind: "direct" | "group" } | null,
  queryThrows: false,
  revalidated: 0,
}))

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({
    isAuthenticated: state.authenticated,
    userId: state.userId,
    has: () => true,
  }),
}))

vi.mock("@trigger.dev/sdk/ai", () => ({
  chat: {
    createStartSessionAction: () => async () => ({ id: "session" }),
    createLoadTranscriptAction: () => async () => ({ messages: [] }),
  },
  defaultStorage: {},
}))

vi.mock("@trigger.dev/sdk", () => ({
  auth: { createPublicToken: async () => "token" },
}))

vi.mock("@sentry/nextjs", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}))

vi.mock("@/queries/chats", () => ({
  getChat: async () => null,
  deleteChatForUser: async (args: { userId: string; chatId: string }) => {
    state.deletedWith = args
    if (state.queryThrows) throw new Error("connection lost")
    return state.queryResult
  },
}))

vi.mock("next/cache", () => ({
  revalidatePath: () => {
    state.revalidated += 1
  },
}))

import { deleteConversationAction } from "@/actions/chat"

describe("deleteConversationAction", () => {
  beforeEach(() => {
    state.authenticated = false
    state.userId = null
    state.deletedWith = null
    state.queryResult = null
    state.queryThrows = false
    state.revalidated = 0
  })

  it("refuses an unauthenticated caller before any query runs", async () => {
    const result = await deleteConversationAction("chat_1")

    expect(result.ok).toBe(false)
    expect(state.deletedWith).toBeNull()
    expect(state.revalidated).toBe(0)
  })

  it("passes the caller's own id alongside the chat id", async () => {
    state.authenticated = true
    state.userId = "user_abc"
    state.queryResult = { id: "chat_1", kind: "direct" }

    const result = await deleteConversationAction("chat_1")

    expect(result).toEqual({ ok: true })
    expect(state.deletedWith).toEqual({ userId: "user_abc", chatId: "chat_1" })
    // The sidebar and search palette are server-rendered: refresh them
    expect(state.revalidated).toBe(1)
  })

  it("answers 'not yours or gone' when the query matches nothing", async () => {
    state.authenticated = true
    state.userId = "user_abc"
    state.queryResult = null

    const result = await deleteConversationAction("someone_elses_chat")

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("no es tuya")
    // Nothing to refresh: no row was removed
    expect(state.revalidated).toBe(0)
  })

  it("keeps the conversation and explains when the delete itself fails", async () => {
    state.authenticated = true
    state.userId = "user_abc"
    state.queryThrows = true

    const result = await deleteConversationAction("chat_1")

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("No se pudo eliminar")
    expect(state.revalidated).toBe(0)
  })

  it("never reaches a query with an id that cannot be a chat id", async () => {
    state.authenticated = true
    state.userId = "user_abc"

    for (const bad of ["", "x".repeat(65), "  ", 42 as unknown as string]) {
      const result = await deleteConversationAction(bad)
      expect(result.ok).toBe(false)
    }

    expect(state.deletedWith).toBeNull()
  })
})
