import { describe, expect, it } from "vitest"

import ActivityPage from "@/app/(dashboard)/activity/page"
import IntegrationsPage from "@/app/(dashboard)/integrations/page"
import DashboardPage from "@/app/dashboard/page"

// Moving Integrations and Activity inside Settings must not break the URLs that
// already exist. These pages are nothing but a redirect, so the test reads the
// destination out of the signal Next throws.

function redirectTarget(page: () => unknown): string | null {
  try {
    page()
    return null
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest
    if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) {
      throw error
    }
    // NEXT_REDIRECT;replace;/settings/integrations;307;
    const parts = digest.split(";")
    return parts[2] ?? null
  }
}

describe("legacy routes", () => {
  it("sends /integrations to Settings → Integrations", () => {
    expect(redirectTarget(IntegrationsPage)).toBe("/settings/integrations")
  })

  it("sends /activity to Settings → Activity", () => {
    expect(redirectTarget(ActivityPage)).toBe("/settings/activity")
  })

  it("sends /dashboard to the agent", () => {
    expect(redirectTarget(DashboardPage)).toBe("/chats")
  })
})
