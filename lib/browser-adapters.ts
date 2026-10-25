// ---------------------------------------------------------------------------
// Browser adapters — the two environments Godfather can browse in.
//
//   cloud  a Browserbase session driven with Playwright over CDP. Created for
//          one execution task, isolated from every other person and task, and
//          released when the task ends.
//   local  the browser on the person's own computer, driven by Paradox Desktop
//          Agent. The agent opens a dedicated Chrome/Edge window with its own
//          profile and reports structured results; the server never needs an
//          inbound connection to the machine.
//
// Both implement the same small contract, so a tool call ("open this URL, read
// what it says") is written once and works in either environment. The adapter
// is chosen from the task's recorded environment — never guessed, never
// switched behind the person's back.
// ---------------------------------------------------------------------------

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"

import type { ExecutionEnvironment, PcAction } from "@/db/schema"
import { browserbaseClient } from "@/lib/browserbase"
import { onlineDevices } from "@/lib/desktop-devices"
import type { EnvironmentAvailability } from "@/lib/execution-router"
import { runPcAction } from "@/lib/pc"
import {
  assertSafeUrl,
  clipPageText,
  withTimeout,
  type BrowserAdapter,
  type BrowserEnvironment,
  type BrowserShot,
  type BrowserTab,
  type PageObservation,
  type PageTarget,
} from "@/lib/browser-sessions"

const NAVIGATION_TIMEOUT_MS = 30_000
const ACTION_TIMEOUT_MS = 20_000
const LOCAL_JOB_TIMEOUT_MS = 95_000
const MAX_TABS = 12

// ---------------------------------------------------------------------------
// Availability — what the tools and the environment card are told
// ---------------------------------------------------------------------------

export type BrowserAvailability = EnvironmentAvailability & {
  /** Online computers that can host a local browser session. */
  localDevices: Array<{ id: string; name: string }>
}

export const CLOUD_NOT_CONFIGURED =
  "the cloud browser is not configured (BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID), so browser work cannot run there — connect Browserbase in Integrations"

export const NO_LOCAL_DEVICE =
  "no computer is online for this account — the person installs and links Paradox Desktop Agent in Settings → Desktop Agent"

export const NO_LOCAL_BROWSER =
  "the linked computer is online but its Desktop Agent does not include the local browser engine — the person updates Paradox Desktop Agent, or the task can run in the cloud browser"

/**
 * What each environment can actually do right now, from configuration and from
 * this person's devices. Nothing is assumed: a missing key or an offline
 * computer is reported as unavailable, with the reason the person is shown.
 */
export async function browserAvailability(
  userId: string,
  env: Record<string, string | undefined> = process.env
): Promise<BrowserAvailability> {
  const cloudConfigured = Boolean(
    env.BROWSERBASE_API_KEY?.trim() && env.BROWSERBASE_PROJECT_ID?.trim()
  )

  let devices: Array<{ id: string; name: string; capabilities: string[] }> = []
  try {
    devices = await onlineDevices(userId)
  } catch {
    // No database or no devices: local browsing is simply unavailable
    devices = []
  }

  const withBrowser = devices.filter((device) =>
    device.capabilities.includes("browser")
  )

  return {
    cloud: {
      available: cloudConfigured,
      reason: cloudConfigured ? "" : CLOUD_NOT_CONFIGURED,
    },
    local: {
      available: withBrowser.length > 0,
      reason:
        withBrowser.length > 0
          ? ""
          : devices.length > 0
            ? NO_LOCAL_BROWSER
            : NO_LOCAL_DEVICE,
    },
    localDevices: withBrowser.map((device) => ({
      id: device.id,
      name: device.name,
    })),
  }
}

// ---------------------------------------------------------------------------
// Cloud adapter — Browserbase + Playwright over CDP
// ---------------------------------------------------------------------------

class CloudBrowserAdapter implements BrowserAdapter {
  readonly environment: BrowserEnvironment = "cloud"
  private readonly pages = new Map<string, Page>()
  private currentPageId = ""
  private counter = 0
  /** Resolves once this session has at least one page to act on. */
  private readonly ready: Promise<void>

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly sessionId: string
  ) {
    // Any page this session opens belongs to this task: a popup is adopted and
    // becomes the current page, because a person clicking a link that opens a
    // tab expects to keep working in that tab.
    context.on("page", (page) => this.adopt(page))

    this.ready = (async () => {
      for (const page of context.pages().slice(0, MAX_TABS)) this.adopt(page)
      if (this.pages.size === 0) this.adopt(await context.newPage())
    })()
  }

  private adopt(page: Page): string {
    for (const [id, known] of this.pages) if (known === page) return id
    const id = `page-${++this.counter}`
    this.pages.set(id, page)
    this.currentPageId = id
    page.on("close", () => {
      this.pages.delete(id)
      if (this.currentPageId === id) {
        const [next] = [...this.pages.keys()]
        this.currentPageId = next ?? ""
      }
    })
    return id
  }

  private async page(target: PageTarget = {}): Promise<Page> {
    await this.ready
    const id = target.pageId ?? this.currentPageId
    const page = id ? this.pages.get(id) : undefined
    if (!page) {
      const known = [...this.pages.keys()].join(", ") || "none"
      throw new Error(
        `This task has no page "${target.pageId ?? "(current)"}". Open one, or pick a tab id: ${known}.`
      )
    }
    this.currentPageId = id
    return page
  }

  private async settle(page: Page) {
    // Wait for navigation to commit, not for the network to go quiet: many real
    // sites keep connections open forever.
    await page
      .waitForLoadState("domcontentloaded", { timeout: 10_000 })
      .catch(() => undefined)
  }

  private async observe(page: Page): Promise<PageObservation> {
    const tabs: BrowserTab[] = []
    for (const [id, candidate] of this.pages) {
      tabs.push({
        id,
        url: candidate.url(),
        title: await candidate.title().catch(() => ""),
        current: id === this.currentPageId,
      })
    }

    return {
      environment: "cloud",
      sessionId: this.sessionId,
      pageId: [...this.pages.entries()].find(([, value]) => value === page)?.[0] ??
        this.currentPageId,
      url: page.url(),
      title: await page.title().catch(() => ""),
      text: clipPageText(
        await page
          .locator("body")
          .innerText({ timeout: 5_000 })
          .catch(() => "")
      ),
      tabs,
    }
  }

  /** Semantic first, then a selector: what a person would call the element. */
  private async locate(page: Page, target: string) {
    const strategies = [
      () => page.locator(target).first(),
      () => page.getByRole("button", { name: target, exact: false }).first(),
      () => page.getByRole("link", { name: target, exact: false }).first(),
      () => page.getByLabel(target, { exact: false }).first(),
      () => page.getByPlaceholder(target, { exact: false }).first(),
      () => page.getByText(target, { exact: false }).first(),
    ]

    for (const strategy of strategies) {
      try {
        const candidate = strategy()
        if ((await candidate.count()) > 0) return candidate
      } catch {
        // Not something this strategy understands; try the next one
      }
    }

    throw new Error(`Nothing on the page matches "${target}".`)
  }

  async navigate({ url, pageId }: PageTarget & { url: string }) {
    const parsed = assertSafeUrl(url)
    const page = await this.page({ pageId })
    await withTimeout(
      page.goto(parsed.toString(), {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      }),
      NAVIGATION_TIMEOUT_MS + 5_000,
      `Opening ${parsed.toString()} took too long.`
    )
    return this.observe(page)
  }

  async read(target: PageTarget = {}) {
    const page = await this.page(target)
    await this.settle(page)
    return this.observe(page)
  }

  async click({ target, pageId }: PageTarget & { target: string }) {
    const page = await this.page({ pageId })
    const before = new Set(this.pages.keys())
    await (await this.locate(page, target)).click({ timeout: ACTION_TIMEOUT_MS })
    await this.settle(page)
    // A click may legitimately open a tab. Give the context a moment to report
    // it, then keep working where the person would be.
    const opened = [...this.pages.keys()].find((id) => !before.has(id))
    if (opened) this.currentPageId = opened
    return this.observe(await this.page())
  }

  async type({
    target,
    text,
    submit,
    pageId,
  }: PageTarget & { target: string; text: string; submit?: boolean }) {
    const page = await this.page({ pageId })
    const field = await this.locate(page, target)
    await field.fill(text, { timeout: ACTION_TIMEOUT_MS })
    if (submit) {
      await field.press("Enter")
      await this.settle(page)
    }
    return this.observe(page)
  }

  async press({ key, pageId }: PageTarget & { key: string }) {
    const page = await this.page({ pageId })
    await page.keyboard.press(key)
    await this.settle(page)
    return this.observe(page)
  }

  async back(target: PageTarget = {}) {
    const page = await this.page(target)
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined)
    return this.observe(page)
  }

  async selectTab({ pageId }: { pageId: string }) {
    const page = await this.page({ pageId })
    await page.bringToFront().catch(() => undefined)
    return this.observe(page)
  }

  async screenshot(target: PageTarget = {}): Promise<BrowserShot> {
    const page = await this.page(target)
    const buffer = await page.screenshot({ type: "png" })
    return {
      base64: buffer.toString("base64"),
      mediaType: "image/png",
      url: page.url(),
      pageId: this.currentPageId,
      width: page.viewportSize()?.width,
      height: page.viewportSize()?.height,
    }
  }

  async close() {
    await this.browser.close().catch(() => undefined)
    // Ending the session stops the meter; a failed release must not throw here
    await browserbaseClient()
      .sessions.update(this.sessionId, { status: "REQUEST_RELEASE" })
      .catch(() => undefined)
  }
}

export async function openCloudBrowser({
  taskId,
  conversationId,
  userId,
}: {
  taskId: string
  conversationId?: string
  userId: string
}): Promise<BrowserAdapter> {
  const apiKey = process.env.BROWSERBASE_API_KEY
  const projectId = process.env.BROWSERBASE_PROJECT_ID
  if (!apiKey?.trim() || !projectId?.trim()) {
    throw new Error(
      "The cloud browser is not configured. Connect Browserbase in Integrations (BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID)."
    )
  }

  const created = await browserbaseClient().sessions.create({
    projectId,
    // Metadata is what makes a session attributable in the provider's console
    userMetadata: { userId, taskId, ...(conversationId ? { conversationId } : {}) },
  })

  try {
    const browser = await chromium.connectOverCDP(created.connectUrl)
    const context = browser.contexts()[0] ?? (await browser.newContext())
    return new CloudBrowserAdapter(browser, context, created.id)
  } catch (error) {
    await browserbaseClient()
      .sessions.update(created.id, { status: "REQUEST_RELEASE" })
      .catch(() => undefined)
    throw error
  }
}

// ---------------------------------------------------------------------------
// Local adapter — the person's own computer, through the Desktop Agent
// ---------------------------------------------------------------------------

type LocalPageResult = {
  pageId: string
  url: string
  title: string
  text: string
  tabs?: BrowserTab[]
}

class LocalBrowserAdapter implements BrowserAdapter {
  readonly environment: BrowserEnvironment = "local"
  /** The device id: what the audit trail needs to explain where work happened. */
  readonly sessionId: string

  constructor(
    private readonly userId: string,
    private readonly deviceId: string,
    private readonly taskId: string,
    readonly deviceName: string
  ) {
    this.sessionId = deviceId
  }

  /** Every local call is one job in this device's queue, bound to this task. */
  private async run(action: PcAction, timeoutMs = LOCAL_JOB_TIMEOUT_MS) {
    return runPcAction(this.userId, action, {
      deviceId: this.deviceId,
      timeoutMs,
    })
  }

  private async observe(
    action: PcAction,
    timeoutMs?: number
  ): Promise<PageObservation> {
    const result = (await this.run(action, timeoutMs)) as LocalPageResult
    if (!result || typeof result.pageId !== "string") {
      throw new Error(
        "The Desktop Agent answered without a page. Update Paradox Desktop Agent so it can drive its browser."
      )
    }
    return {
      environment: "local",
      sessionId: this.deviceId,
      pageId: result.pageId,
      url: result.url ?? "",
      title: result.title ?? "",
      text: clipPageText(result.text ?? ""),
      tabs: (result.tabs ?? []).map((tab) => ({
        ...tab,
        current: tab.id === result.pageId,
      })),
    }
  }

  private base(pageId?: string) {
    return { sessionKey: this.taskId, ...(pageId ? { pageId } : {}) }
  }

  async navigate({ url, pageId }: PageTarget & { url: string }) {
    const parsed = assertSafeUrl(url)
    return this.observe({
      kind: "browser_navigate",
      ...this.base(pageId),
      url: parsed.toString(),
    })
  }

  async read(target: PageTarget = {}) {
    return this.observe({ kind: "browser_read", ...this.base(target.pageId) })
  }

  async click({ target, pageId }: PageTarget & { target: string }) {
    return this.observe({
      kind: "browser_click",
      ...this.base(pageId),
      target,
    })
  }

  async type({
    target,
    text,
    submit,
    pageId,
  }: PageTarget & { target: string; text: string; submit?: boolean }) {
    return this.observe({
      kind: "browser_type",
      ...this.base(pageId),
      target,
      text,
      submit,
    })
  }

  async press({ key, pageId }: PageTarget & { key: string }) {
    return this.observe({ kind: "browser_press", ...this.base(pageId), key })
  }

  async back(target: PageTarget = {}) {
    return this.observe({ kind: "browser_back", ...this.base(target.pageId) })
  }

  async selectTab({ pageId }: { pageId: string }) {
    return this.observe({ kind: "browser_select_tab", ...this.base(pageId), pageId })
  }

  async screenshot(target: PageTarget = {}): Promise<BrowserShot> {
    const result = (await this.run({
      kind: "browser_screenshot",
      ...this.base(target.pageId),
    })) as {
      image?: string
      width?: number
      height?: number
      pageId?: string
      url?: string
    }
    if (!result?.image) {
      throw new Error("The Desktop Agent returned an empty screenshot.")
    }
    const [header, data] = result.image.split(",")
    return {
      base64: data ?? "",
      mediaType: header?.includes("jpeg") ? "image/jpeg" : "image/png",
      url: result.url ?? "",
      pageId: result.pageId ?? "",
      width: result.width,
      height: result.height,
    }
  }

  async close() {
    // Closing is best effort: the person may have closed the window already
    await this.run({ kind: "browser_close", sessionKey: this.taskId }, 20_000)
      .catch(() => undefined)
  }

  get name() {
    return this.deviceName
  }
}


export async function openLocalBrowser({
  userId,
  taskId,
}: {
  userId: string
  taskId: string
  /** Accepted for a uniform opener signature; local jobs are keyed by task. */
  conversationId?: string
}): Promise<BrowserAdapter> {
  const availability = await browserAvailability(userId)
  if (!availability.local.available) throw new Error(availability.local.reason)

  const device = availability.localDevices[0]
  const adapter = new LocalBrowserAdapter(userId, device.id, taskId, device.name)

  // Prove the engine can open a window before the first action is planned
  const opened = (await runPcAction(
    userId,
    { kind: "browser_open", sessionKey: taskId },
    { deviceId: device.id, timeoutMs: LOCAL_JOB_TIMEOUT_MS }
  )) as LocalPageResult

  if (!opened?.pageId) {
    throw new Error(NO_LOCAL_BROWSER)
  }

  return adapter
}

// ---------------------------------------------------------------------------
// Choosing the adapter for a task
// ---------------------------------------------------------------------------

/** Opens the adapter for the environment the task recorded. */
export async function openBrowserForTask({
  environment,
  taskId,
  conversationId,
  userId,
}: {
  environment: ExecutionEnvironment
  taskId: string
  conversationId?: string
  userId: string
}): Promise<BrowserAdapter> {
  return environment === "cloud"
    ? openCloudBrowser({ taskId, conversationId, userId })
    : openLocalBrowser({ userId, taskId, conversationId })
}
