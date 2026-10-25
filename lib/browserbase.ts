import Browserbase from "@browserbasehq/sdk"

// Server-only Browserbase client for observability calls (session replays, logs)
// and for creating the browser sessions tasks run in. It carries the secret API
// key, so it must never be imported into client code.
//
// The client is created on first use, not at import: the SDK throws when no key
// is configured, and the app must keep running without Browserbase (the local
// browser route, or no browser at all) instead of failing to load a module.

let client: Browserbase | undefined

export function browserbaseClient(): Browserbase {
  if (client) return client

  const apiKey = process.env.BROWSERBASE_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      "BROWSERBASE_API_KEY is not set, so there is no Browserbase client. Connect Browserbase in Integrations to use the cloud browser."
    )
  }

  client = new Browserbase({ apiKey })
  return client
}
