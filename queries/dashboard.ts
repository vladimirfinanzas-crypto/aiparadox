import { auth } from "@clerk/nextjs/server"
import { and, eq, gte, inArray, sql } from "drizzle-orm"

import { db } from "@/db"
import {
  chats,
  pcJobs,
  usageEntries,
  widgets,
  workflows,
  type UsageKind,
} from "@/db/schema"

// The numbers the dashboard surfaces share: how much the person has built and
// whether anything is running right now. Every query is scoped to the session's
// userId, never to an id sent from the browser.
export async function getDashboardStats() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const count = () => sql<number>`count(*)`.mapWith(Number)

  const [chatRows, panelRows, automationRows, pendingRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(chats)
      .where(eq(chats.userId, userId)),
    db
      .select({ value: count() })
      .from(widgets)
      .where(eq(widgets.userId, userId)),
    db
      .select({ value: count() })
      .from(workflows)
      .where(eq(workflows.userId, userId)),
    db
      .select({ value: count() })
      .from(pcJobs)
      .where(
        and(
          eq(pcJobs.userId, userId),
          inArray(pcJobs.status, ["pending", "claimed"])
        )
      ),
  ])

  return {
    chats: chatRows[0]?.value ?? 0,
    panels: panelRows[0]?.value ?? 0,
    automations: automationRows[0]?.value ?? 0,
    pendingJobs: pendingRows[0]?.value ?? 0,
  }
}

export type UsageSummary = Record<UsageKind, number>

// What the ledger says this person spent in the last `days` days, by kind. It
// is read straight from usage_entries so it works whether or not billing is
// enabled (the test build has no subscription period to look up).
export async function getUsageSummary(days = 30): Promise<UsageSummary> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const rows = await db
    .select({
      kind: usageEntries.kind,
      amount: sql<number>`sum(${usageEntries.amount})`.mapWith(Number),
    })
    .from(usageEntries)
    .where(
      and(
        eq(usageEntries.userId, userId),
        gte(usageEntries.createdAt, since)
      )
    )
    .groupBy(usageEntries.kind)

  const summary: UsageSummary = { ai: 0, sandbox: 0, browser: 0, social: 0 }
  for (const row of rows) summary[row.kind] = row.amount

  return summary
}
