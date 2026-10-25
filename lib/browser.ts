import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"

// The browser agent's engine: a real Chromium driven over CDP on Browserbase.
// Playwright is the layer the agent talks to; Browserbase supplies the running
// browser, its proxy, and the recording of the session.
//
// One connection is kept per workflow run or chat turn and must be closed by
// the caller — `withBrowser` does that for the common case.

const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID

function connectEndpoint(): string {
  const apiKey = process.env.BROWSERBASE_API_KEY
  if (!apiKey) {
    throw new Error(
      "BROWSERBASE_API_KEY is not set, so there is no browser to connect to."
    )
  }
  if (!BROWSERBASE_PROJECT_ID) {
    throw new Error(
      "BROWSERBASE_PROJECT_ID is not set, so no browser session can be created."
    )
  }

  const url = new URL("wss://connect.browserbase.com")
  url.searchParams.set("apiKey", apiKey)
  url.searchParams.set("projectId", BROWSERBASE_PROJECT_ID)
  return url.toString()
}

export type BrowserSession = {
  browser: Browser
  context: BrowserContext
  page: Page
}

// Opens a cloud browser and returns the first page to work on. New pages should
// be opened on `context` so they share the session and its recording.
export async function connectBrowser(): Promise<BrowserSession> {
  // `browserbase` keeps the session alive past this process so a replay exists
  const browser = await chromium.connectOverCDP(connectEndpoint(), {
    headers: {
      "X-Browserbase-Session-Id": process.env.BROWSERBASE_SESSION_ID ?? "",
    },
  })

  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = context.pages()[0] ?? (await context.newPage())

  return { browser, context, page }
}

// Runs `fn` with a live session and always closes the connection afterwards, so
// a failed step never leaves a paid browser running.
export async function withBrowser<T>(
  fn: (session: BrowserSession) => Promise<T>
): Promise<T> {
  const session = await connectBrowser()
  try {
    return await fn(session)
  } finally {
    await session.browser.close().catch(() => undefined)
  }
}

// What the agent gets back from a navigation: enough to say where it ended up
export async function describePage(page: Page) {
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    text: (await page
      .locator("body")
      .innerText({ timeout: 5_000 })
      .catch(() => "")).slice(0, 4000),
  }
}
