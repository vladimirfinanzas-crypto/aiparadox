// ---------------------------------------------------------------------------
// Browser sessions — one per execution task, never one per process.
//
// The rule this file exists to enforce: a browser tool never asks "what is the
// current page?". It asks "what is the current page *of this task*", and the
// answer lives in that task's own session.
//
//   taskId ─▶ { adapter, environment, conversationId, openedAt }
//
// Two tasks in the same chat get two sessions. A task in "local" and a task in
// "cloud" get two adapters. Nothing is shared, and a session is closed when its
// task ends or its conversation's turn is over — a paid cloud browser never
// outlives the work it was opened for.
//
// The registry is adapter-agnostic on purpose: the cloud (Browserbase) and the
// local (Desktop Agent) implementations live in `lib/browser-adapters.ts`, and
// the tests drive the registry with fakes.
// ---------------------------------------------------------------------------

import type { ExecutionEnvironment } from "@/db/schema"

export type BrowserEnvironment = ExecutionEnvironment

export type BrowserTab = {
  id: string
  url: string
  title: string
  /** The tab this task is acting on right now. */
  current: boolean
}

/** What every browser tool returns: where the task ended up, and how it looks. */
export type PageObservation = {
  environment: BrowserEnvironment
  sessionId: string
  pageId: string
  url: string
  title: string
  text: string
  tabs: BrowserTab[]
}

export type BrowserShot = {
  base64: string
  mediaType: string
  url: string
  pageId: string
  width?: number
  height?: number
}

export type PageTarget = { pageId?: string }

/**
 * The contract both environments implement. Godfather only ever sees these
 * operations, so the same tool works on Browserbase and on the person's PC
 * without the model knowing which one is behind it.
 */
export type BrowserAdapter = {
  readonly environment: BrowserEnvironment
  /** Cloud session id, or the device id for a local session — for the audit log. */
  readonly sessionId: string
  navigate(input: PageTarget & { url: string }): Promise<PageObservation>
  read(input?: PageTarget): Promise<PageObservation>
  click(input: PageTarget & { target: string }): Promise<PageObservation>
  type(
    input: PageTarget & { target: string; text: string; submit?: boolean }
  ): Promise<PageObservation>
  press(input: PageTarget & { key: string }): Promise<PageObservation>
  back(input?: PageTarget): Promise<PageObservation>
  selectTab(input: { pageId: string }): Promise<PageObservation>
  screenshot(input?: PageTarget): Promise<BrowserShot>
  close(): Promise<void>
}

export type BrowserSession = {
  taskId: string
  conversationId?: string
  environment: BrowserEnvironment
  adapter: BrowserAdapter
  openedAt: number
}

const sessions = new Map<string, BrowserSession>()
// A tool call that opens a session while another is still opening must not
// create a second paid browser: the in-flight promise is shared.
const opening = new Map<string, Promise<BrowserSession>>()

export type OpenBrowser = (args: {
  taskId: string
  conversationId?: string
  environment: BrowserEnvironment
}) => Promise<BrowserAdapter>

/**
 * The session for one task, opened on first use. Reusing a session is what
 * makes a multi-step task cheap: navigation, reading, clicking and screenshot
 * all act on the same pages, the same cookies and the same tab.
 */
export async function taskBrowser({
  taskId,
  conversationId,
  environment,
  open,
}: {
  taskId: string
  conversationId?: string
  environment: BrowserEnvironment
  open: OpenBrowser
}): Promise<BrowserSession> {
  const existing = sessions.get(taskId)
  if (existing) {
    if (existing.environment !== environment) {
      // An environment is never changed silently; the caller has a bug if it
      // tries, so the old session is disposed instead of being reused with the
      // wrong credentials or profile.
      await closeTaskBrowser(taskId)
    } else {
      return existing
    }
  }

  const pending = opening.get(taskId)
  if (pending) return pending

  const promise = (async () => {
    const adapter = await open({ taskId, conversationId, environment })
    const session: BrowserSession = {
      taskId,
      conversationId,
      environment,
      adapter,
      openedAt: Date.now(),
    }
    sessions.set(taskId, session)
    return session
  })()

  opening.set(taskId, promise)
  try {
    return await promise
  } finally {
    opening.delete(taskId)
  }
}

/** The open session for a task, without opening one. */
export function peekTaskBrowser(taskId: string): BrowserSession | undefined {
  return sessions.get(taskId)
}

export async function closeTaskBrowser(taskId: string): Promise<void> {
  const session = sessions.get(taskId)
  sessions.delete(taskId)
  opening.delete(taskId)
  if (session) await session.adapter.close().catch(() => undefined)
}

/** Called when a chat turn ends: no session survives the turn that opened it. */
export async function closeConversationBrowsers(
  conversationId: string
): Promise<number> {
  const ids = [...sessions.values()]
    .filter((session) => session.conversationId === conversationId)
    .map((session) => session.taskId)

  await Promise.all(ids.map((id) => closeTaskBrowser(id)))
  return ids.length
}

export async function closeAllTaskBrowsers(): Promise<number> {
  const ids = [...sessions.keys()]
  await Promise.all(ids.map((id) => closeTaskBrowser(id)))
  return ids.length
}

/** Test/diagnostics helper: how many sessions are open right now. */
export function openBrowserSessionCount(): number {
  return sessions.size
}

// ---------------------------------------------------------------------------
// Shared helpers for the adapters
// ---------------------------------------------------------------------------

const MAX_PAGE_TEXT = 6_000

/** The page text a tool answers with: enough to work from, never the whole DOM. */
export function clipPageText(text: string): string {
  const normalized = text.replace(/\n{3,}/g, "\n\n").trim()
  return normalized.length > MAX_PAGE_TEXT
    ? `${normalized.slice(0, MAX_PAGE_TEXT)}\n… ${normalized.length - MAX_PAGE_TEXT} more characters`
    : normalized
}

/**
 * A timeout with a message the model can act on. Tool calls must never hang on
 * a page that keeps a connection open.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Only http(s) is ever opened: no file://, no browser-internal pages. */
export function assertSafeUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`"${url}" is not a complete URL. Include https://.`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Only http and https pages can be opened; "${parsed.protocol}" is not allowed.`
    )
  }
  return parsed
}
