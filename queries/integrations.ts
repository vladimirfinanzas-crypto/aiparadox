import { auth } from "@clerk/nextjs/server"

import { getOrCreateIntegration } from "@/lib/pc"

export type ServiceId =
  | "openrouter"
  | "browserbase"
  | "zernio"
  | "trigger"
  | "sentry"
  | "database"
  | "clerk"
  | "resend"

export type EnvironmentStatus = Record<ServiceId, boolean>

// Which secrets the server can see, as booleans only. The values never leave
// the server and are never rendered, logged or sent to the client.
export function getEnvironmentStatus(): EnvironmentStatus {
  const has = (value: string | undefined) =>
    Boolean(value && value.trim().length > 0)

  return {
    openrouter: has(process.env.OPENROUTER_API_KEY),
    browserbase:
      has(process.env.BROWSERBASE_API_KEY) &&
      has(process.env.BROWSERBASE_PROJECT_ID),
    zernio: has(process.env.ZERNIO_API_KEY),
    trigger: has(process.env.TRIGGER_SECRET_KEY),
    sentry: has(process.env.NEXT_PUBLIC_SENTRY_DSN),
    database: has(process.env.DATABASE_URL),
    clerk: has(process.env.CLERK_SECRET_KEY),
    resend: has(process.env.RESEND_API_KEY),
  }
}

// This person's integration row: the Zernio profile and the token their local
// PyAutoGUI agent authenticates with. Created on demand so the settings page
// always has something to show.
export async function getMyIntegration() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const integration = await getOrCreateIntegration(userId)
  return { userId, integration }
}
