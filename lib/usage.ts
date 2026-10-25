import { createClerkClient } from "@clerk/backend"
import { and, eq, gte, sql } from "drizzle-orm"

import { db } from "@/db"
import { usageEntries, type NewUsageEntry, type UsageKind } from "@/db/schema"

// Not @clerk/nextjs: the Trigger.dev tasks meter usage too, outside Next.js
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY })

// What one billing period of the paid plan includes
export const usageLimits: Record<UsageKind, number> = {
  // $10 of model spend, in millionths of a dollar
  ai: 10_000_000,
  // 50 hours of running sandboxes, in seconds
  sandbox: 50 * 60 * 60,
  // 5 hours of cloud browser sessions, in seconds
  browser: 5 * 60 * 60,
  // 200 social posts published per billing period
  social: 200,
}

// The billing period the user's paid plan is in, or null without a paid plan.
// Billing being disabled for the Clerk instance (or the API being unreachable)
// reads the same as no plan: every caller already handles null, and a failed
// lookup must not take down the pages that meter usage.
async function getBillingPeriod(userId: string) {
  const subscription = await clerk.billing
    .getUserBillingSubscription(userId)
    .catch(() => null)
  if (!subscription) return null

  // The free plan is a subscription item too, but one that never ends
  const item = subscription.subscriptionItems.find(
    (item) => item.status === "active" && item.periodEnd
  )
  if (!item?.periodEnd) return null

  return { start: new Date(item.periodStart), end: new Date(item.periodEnd) }
}

// What the user has used and has left in their current billing period, or null
// without a paid plan. Takes the user ID so tasks can ask without a session.
export async function getUsage(userId: string) {
  const period = await getBillingPeriod(userId)
  if (!period) return null

  const rows = await db
    .select({
      kind: usageEntries.kind,
      amount: sql`sum(${usageEntries.amount})`.mapWith(Number),
    })
    .from(usageEntries)
    .where(
      and(
        eq(usageEntries.userId, userId),
        gte(usageEntries.createdAt, period.start)
      )
    )
    .groupBy(usageEntries.kind)

  const used: Record<UsageKind, number> = {
    ai: 0,
    sandbox: 0,
    browser: 0,
    social: 0,
  }
  for (const row of rows) used[row.kind] = row.amount

  const remaining: Record<UsageKind, number> = {
    ai: Math.max(0, usageLimits.ai - used.ai),
    sandbox: Math.max(0, usageLimits.sandbox - used.sandbox),
    browser: Math.max(0, usageLimits.browser - used.browser),
    social: Math.max(0, usageLimits.social - used.social),
  }

  return {
    period,
    used,
    remaining,
  }
}

export type Usage = NonNullable<Awaited<ReturnType<typeof getUsage>>>

// A stand-in allowance for when there is no billing period to read: everything
// allowed, nothing measured. The test version's open paywall points every
// turn-time check here instead of blocking on a missing subscription.
export const UNLIMITED_USAGE: Usage = {
  period: { start: new Date(0), end: new Date("9999-12-31") },
  used: { ai: 0, browser: 0, sandbox: 0, social: 0 },
  remaining: {
    ai: Number.MAX_SAFE_INTEGER,
    browser: Number.MAX_SAFE_INTEGER,
    sandbox: Number.MAX_SAFE_INTEGER,
    social: Number.MAX_SAFE_INTEGER,
  },
}

// Adds to the ledger. An entry whose key is already there is left out.
export async function recordUsage(entries: NewUsageEntry[]) {
  if (entries.length === 0) return

  await db
    .insert(usageEntries)
    .values(entries)
    .onConflictDoNothing({ target: usageEntries.idempotencyKey })
}
