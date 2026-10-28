// Render's healthcheck (healthCheckPath in render.yaml): a deployment only
// takes traffic once this answers 200.
// It says the server is up, not that the database or any other service is.
//
// `GET /api/health?env=1` additionally reports which of the documented
// environment variables this process can see — NAMES AND PRESENCE ONLY, never
// a value, never a prefix. It exists so the operator (or an agent without
// dashboard access) can tell "the key is missing" from "the key is wrong"
// without printing a secret. The list is a fixed allowlist: anything else in
// the environment is not mentioned at all.
const REQUIRED = [
  "DATABASE_URL",
  "CLERK_SECRET_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL",
  "TRIGGER_SECRET_KEY",
] as const

const OPTIONAL = [
  // AI providers (router skips the ones without a key)
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "CEREBRAS_API_KEY",
  "GROQ_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  // Godfather's cloud browser
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
  // Email, social, sandboxes
  "RESEND_API_KEY",
  "RESEND_FROM",
  "ZERNIO_API_KEY",
  "DAYTONA_API_KEY",
  // Integration centre + telemetry + migrations
  "INTEGRATIONS_ENCRYPTION_KEY",
  "DATABASE_URL_UNPOOLED",
  "NEXT_PUBLIC_SENTRY_DSN",
] as const

const isPresent = (key: string) => (process.env[key] ?? "").trim().length > 0

export function GET(request: Request) {
  const wantsEnv = new URL(request.url).searchParams.get("env") === "1"
  if (!wantsEnv) return Response.json({ status: "ok" })

  const report = (keys: readonly string[]) =>
    keys.reduce<{ present: string[]; missing: string[] }>(
      (acc, key) => {
        acc[isPresent(key) ? "present" : "missing"].push(key)
        return acc
      },
      { present: [], missing: [] },
    )

  return Response.json({
    status: "ok",
    required: report(REQUIRED),
    optional: report(OPTIONAL),
    note: "names only; values are never returned",
  })
}
