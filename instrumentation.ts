import * as Sentry from "@sentry/nextjs"

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config")

    // Names the AI providers that are configured and those that are not, once
    // per process. Only names and variable names are printed, never a value.
    const { logAiProviderConfiguration } = await import(
      "./lib/ai/provider-registry"
    )
    logAiProviderConfiguration()
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config")
  }
}

export const onRequestError = Sentry.captureRequestError
