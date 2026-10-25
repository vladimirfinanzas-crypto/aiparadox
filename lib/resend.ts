import { Resend } from "resend"

// Built per call so a missing key fails that one call with a clear message
// instead of crashing every module that imports this file (Trigger.dev bundles
// the workflow nodes at startup, where the key may not be present yet).
export function resend() {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not set, so email can't be sent. Set it in the environment (and in Trigger.dev's dashboard for workflow tasks)."
    )
  }

  return new Resend(apiKey)
}
