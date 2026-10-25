// Slugs of the features on the paid plan in Clerk. The free plan has neither.
export type Feature = "bots" | "sandboxes"

// Test version: every pay gate in the app reads this flag. While false, nothing
// checks features or usage allowances, so no flow stops mid-process. Re-enable
// billing by flipping it back to true — the checks are all still in place.
export const PAYWALL_ENABLED = false

// Thrown by the chat agent, and recognised by the chat, when a turn can't start
// because the billing period's allowance is spent
export const USAGE_LIMIT_ERROR =
  "You've used up your usage for this billing period."
