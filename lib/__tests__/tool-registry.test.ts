import { describe, expect, it, vi } from "vitest"

// The registry imports the device store, which imports the database pool;
// nothing here talks to a real database.
vi.mock("@/db", () => ({ db: {} }))

import {
  TOOL_GROUPS,
  formatAvailabilityReport,
  getToolAvailability,
  groupForTool,
  registeredToolNames,
  type ToolGroupId,
} from "@/lib/tool-registry"

const ALL_ENV = {
  BROWSERBASE_API_KEY: "bb-key",
  BROWSERBASE_PROJECT_ID: "bb-project",
  ZERNIO_API_KEY: "zernio-key",
  RESEND_API_KEY: "resend-key",
}

describe("tool registry metadata", () => {
  it("registers every group with tools, permissions and a timeout", () => {
    expect(TOOL_GROUPS.length).toBeGreaterThan(0)
    for (const group of TOOL_GROUPS) {
      expect(group.tools.length, `${group.id} has no tools`).toBeGreaterThan(0)
      expect(group.permissions.length).toBeGreaterThan(0)
      expect(group.timeoutMs).toBeGreaterThan(0)
      expect(group.integration.length).toBeGreaterThan(0)
    }
  })

  it("never assigns the same tool name to two groups", () => {
    const names = registeredToolNames()
    expect(new Set(names).size).toBe(names.length)
  })

  it("requires approval for every high-risk group", () => {
    for (const group of TOOL_GROUPS) {
      if (group.risk === "high") {
        expect(group.requiresApproval, `${group.id}`).toBe(true)
      }
    }
  })

  it("resolves a tool to its group", () => {
    expect(groupForTool("social_publish")?.id).toBe("social")
    expect(groupForTool("email_send")?.id).toBe("email")
    expect(groupForTool("browser_navigate")?.id).toBe("browser")
    expect(groupForTool("no_such_tool")).toBeUndefined()
  })
})

describe("availability from configuration", () => {
  it("marks a group unavailable when its key is missing, with a reason", () => {
    const availability = getToolAvailability({ BROWSERBASE_API_KEY: "only-this" })

    expect(availability.email.available).toBe(false)
    expect(availability.email.reason).toContain("RESEND_API_KEY")
    expect(availability.social.available).toBe(false)
    expect(availability.social.reason).toContain("ZERNIO_API_KEY")
    expect(availability.browser.available).toBe(false)

    // Workspace and sandbox need no integration key at all
    expect(availability.workspace.available).toBe(true)
    expect(availability.sandbox.available).toBe(true)
  })

  it("marks a group available when every required variable is present", () => {
    const availability = getToolAvailability(ALL_ENV)
    const ids = Object.keys(availability) as ToolGroupId[]

    for (const id of ids) {
      expect(availability[id].available, id).toBe(true)
      expect(availability[id].reason).toBe("")
    }
  })

  it("treats an empty value as missing", () => {
    const availability = getToolAvailability({
      ...ALL_ENV,
      RESEND_API_KEY: "   ",
    })
    expect(availability.email.available).toBe(false)
  })
})

describe("availability report for the model", () => {
  it("lists configured integrations and refuses to fake the missing ones", () => {
    const availability = getToolAvailability({
      BROWSERBASE_API_KEY: "bb",
      BROWSERBASE_PROJECT_ID: "bb",
      // no Zernio, no Resend
    })

    const report = formatAvailabilityReport(availability, { onlineDevices: 1 })

    expect(report).toContain("Browserbase + Playwright: AVAILABLE")
    expect(report).toContain("browser_navigate")
    expect(report).toContain("Zernio: NOT CONFIGURED")
    expect(report).toContain("Resend: NOT CONFIGURED")
    expect(report).toContain("1 device online")
    expect(report).toContain(
      "Never claim an action succeeded when its tool was unavailable"
    )
  })

  it("reports the desktop agent as having no device online", () => {
    const report = formatAvailabilityReport(getToolAvailability(ALL_ENV), {
      onlineDevices: 0,
    })

    expect(report).toContain("NO DEVICE ONLINE")
    expect(report).toContain("Settings → Desktop Agent")
  })
})

describe("browser routes in the registry", () => {
  it("registers the tab tools and the environment question", () => {
    expect(groupForTool("browser_tabs")?.id).toBe("browser")
    expect(groupForTool("browser_select_tab")?.id).toBe("browser")
    expect(groupForTool("request_execution_environment")?.id).toBe("router")
  })

  it("describes both environments for the browser group", () => {
    const browser = TOOL_GROUPS.find((group) => group.id === "browser")
    expect(browser?.environments).toEqual(["cloud", "local"])
    expect(browser?.verification?.length).toBeGreaterThan(0)
    expect(browser?.resultType).toBe("structured")
  })

  it("reports the person's PC as a working browser route without a Browserbase key", () => {
    const report = formatAvailabilityReport(getToolAvailability({}), {
      onlineDevices: 1,
      localBrowser: true,
    })

    expect(report).toContain("AVAILABLE THROUGH THE PERSON'S PC")
    expect(report).not.toContain("Browserbase + Playwright: NOT CONFIGURED")
  })

  it("keeps internal plumbing out of what the model is told", () => {
    const report = formatAvailabilityReport(getToolAvailability(ALL_ENV), {
      onlineDevices: 0,
    })

    expect(report).not.toContain("request_execution_environment")
    expect(report).not.toContain("handoff")
  })
})
