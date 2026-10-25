import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  assertSafeUrl,
  closeAllTaskBrowsers,
  closeConversationBrowsers,
  closeTaskBrowser,
  openBrowserSessionCount,
  peekTaskBrowser,
  taskBrowser,
  withTimeout,
  type BrowserAdapter,
} from "@/lib/browser-sessions"

// A fake adapter: the registry only ever sees this contract, so the test proves
// the isolation and the lifecycle without Playwright, a browser or a network.
function fakeAdapter(environment: "local" | "cloud", sessionId: string) {
  const close = vi.fn(async () => undefined)
  const adapter: BrowserAdapter = {
    environment,
    sessionId,
    navigate: async () => observation(environment, sessionId),
    read: async () => observation(environment, sessionId),
    click: async () => observation(environment, sessionId),
    type: async () => observation(environment, sessionId),
    press: async () => observation(environment, sessionId),
    back: async () => observation(environment, sessionId),
    selectTab: async () => observation(environment, sessionId),
    screenshot: async () => ({
      base64: "",
      mediaType: "image/png",
      url: "",
      pageId: "p1",
    }),
    close,
  }
  return { adapter, close }
}

function observation(environment: "local" | "cloud", sessionId: string) {
  return {
    environment,
    sessionId,
    pageId: "p1",
    url: "https://example.com",
    title: "Example",
    text: "hello",
    tabs: [],
  }
}

beforeEach(async () => {
  await closeAllTaskBrowsers()
})

describe("one browser per task", () => {
  it("opens a session on first use and reuses it afterwards", async () => {
    const open = vi.fn(async () => fakeAdapter("cloud", "s1").adapter)

    const first = await taskBrowser({
      taskId: "task-a",
      conversationId: "chat-1",
      environment: "cloud",
      open,
    })
    const second = await taskBrowser({
      taskId: "task-a",
      conversationId: "chat-1",
      environment: "cloud",
      open,
    })

    expect(open).toHaveBeenCalledTimes(1)
    expect(second.adapter).toBe(first.adapter)
    expect(openBrowserSessionCount()).toBe(1)
  })

  it("never shares a session between two tasks", async () => {
    const open = vi.fn(async ({ taskId }: { taskId: string }) =>
      fakeAdapter("cloud", `session-${taskId}`).adapter
    )

    const a = await taskBrowser({
      taskId: "task-a",
      conversationId: "chat-1",
      environment: "cloud",
      open,
    })
    const b = await taskBrowser({
      taskId: "task-b",
      conversationId: "chat-1",
      environment: "cloud",
      open,
    })

    expect(a.adapter).not.toBe(b.adapter)
    expect(a.adapter.sessionId).toBe("session-task-a")
    expect(b.adapter.sessionId).toBe("session-task-b")
    expect(openBrowserSessionCount()).toBe(2)
  })

  it("shares one open when two tool calls race for the same task", async () => {
    const { adapter } = fakeAdapter("local", "device-1")
    const open = vi.fn(
      async () =>
        new Promise<BrowserAdapter>((resolve) => setTimeout(() => resolve(adapter), 5))
    )

    const [first, second] = await Promise.all([
      taskBrowser({ taskId: "task-c", environment: "local", open }),
      taskBrowser({ taskId: "task-c", environment: "local", open }),
    ])

    expect(open).toHaveBeenCalledTimes(1)
    expect(first.adapter).toBe(second.adapter)
  })

  it("disposes the session when the environment changes instead of reusing it", async () => {
    const cloud = fakeAdapter("cloud", "cloud-1")
    const local = fakeAdapter("local", "device-1")

    await taskBrowser({
      taskId: "task-d",
      environment: "cloud",
      open: async () => cloud.adapter,
    })
    await taskBrowser({
      taskId: "task-d",
      environment: "local",
      open: async () => local.adapter,
    })

    expect(cloud.close).toHaveBeenCalledTimes(1)
    expect(peekTaskBrowser("task-d")?.adapter).toBe(local.adapter)
  })

  it("closes only the sessions of the conversation whose turn ended", async () => {
    const first = fakeAdapter("cloud", "s1")
    const second = fakeAdapter("cloud", "s2")

    await taskBrowser({
      taskId: "task-a",
      conversationId: "chat-1",
      environment: "cloud",
      open: async () => first.adapter,
    })
    await taskBrowser({
      taskId: "task-b",
      conversationId: "chat-2",
      environment: "cloud",
      open: async () => second.adapter,
    })

    const closed = await closeConversationBrowsers("chat-1")

    expect(closed).toBe(1)
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    expect(peekTaskBrowser("task-b")).toBeDefined()
  })

  it("closes a task's browser exactly once", async () => {
    const { adapter, close } = fakeAdapter("local", "device-1")
    await taskBrowser({
      taskId: "task-e",
      environment: "local",
      open: async () => adapter,
    })

    await closeTaskBrowser("task-e")
    await closeTaskBrowser("task-e")

    expect(close).toHaveBeenCalledTimes(1)
    expect(openBrowserSessionCount()).toBe(0)
  })
})

describe("safety helpers", () => {
  it("only allows http and https pages", () => {
    expect(assertSafeUrl("https://example.com/a").host).toBe("example.com")
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(/http and https/i)
    expect(() => assertSafeUrl("chrome://settings")).toThrow(/http and https/i)
    expect(() => assertSafeUrl("example.com")).toThrow(/complete URL/i)
  })

  it("stops an operation that never settles", async () => {
    await expect(
      withTimeout(new Promise(() => undefined), 10, "too slow")
    ).rejects.toThrow("too slow")
    await expect(withTimeout(Promise.resolve("ok"), 50, "too slow")).resolves.toBe(
      "ok"
    )
  })
})
