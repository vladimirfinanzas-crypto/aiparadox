// Which credentials the server can actually see, by name. Never values.
//
// Validation uses this to tell the difference between "the flow is wrong" and
// "this account has not configured Browserbase", which are different messages
// for the person.
export function availableEnvNames(): string[] {
  return Object.entries(process.env)
    .filter(([, value]) => Boolean(value && value.trim().length > 0))
    .map(([name]) => name)
}

export function hasEnv(name: string): boolean {
  const value = process.env[name]
  return Boolean(value && value.trim().length > 0)
}
