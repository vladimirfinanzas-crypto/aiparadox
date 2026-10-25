import { describe, expect, it, vi } from "vitest"

// Availability is a read: no browser is opened and no job is queued here.
const h = vi.hoisted(() => ({
  devices: [] as Array<{
    id: string
    name: string
    status: string
    lastSeenAt: Date | null
    capabilities: string[]
  }>,
}))

vi.mock("@/lib/desktop-devices", () => ({
  onlineDevices: async () => h.devices,
}))
vi.mock("@/lib/pc", () => ({ runPcAction: vi.fn() }))

import {
  CLOUD_NOT_CONFIGURED,
  NO_LOCAL_BROWSER,
  NO_LOCAL_DEVICE,
  browserAvailability,
} from "@/lib/browser-adapters"

const KEYS = {
  BROWSERBASE_API_KEY: "bb-key",
  BROWSERBASE_PROJECT_ID: "bb-project",
}

function device(capabilities: string[]) {
  return {
    id: "device-1",
    name: "PORTATIL",
    status: "online",
    lastSeenAt: new Date(),
    capabilities,
  }
}

describe("browser availability", () => {
  it("reports both routes as unavailable, with the reason for each", async () => {
    h.devices = []
    const availability = await browserAvailability("user_1", {})

    expect(availability.cloud.available).toBe(false)
    expect(availability.cloud.reason).toBe(CLOUD_NOT_CONFIGURED)
    expect(availability.local.available).toBe(false)
    expect(availability.local.reason).toBe(NO_LOCAL_DEVICE)
    expect(availability.localDevices).toEqual([])
  })

  it("uses the cloud route once Browserbase is configured", async () => {
    h.devices = []
    const availability = await browserAvailability("user_1", KEYS)

    expect(availability.cloud.available).toBe(true)
    expect(availability.cloud.reason).toBe("")
  })

  it("does not pretend an old Desktop Agent can browse", async () => {
    h.devices = [device(["screen", "mouse", "keyboard", "run"])]
    const availability = await browserAvailability("user_1", {})

    expect(availability.local.available).toBe(false)
    expect(availability.local.reason).toBe(NO_LOCAL_BROWSER)
  })

  it("offers the local route only for a computer that reports the engine", async () => {
    h.devices = [
      device(["screen", "mouse", "keyboard", "run"]),
      { ...device(["screen", "browser"]), id: "device-2", name: "SOBREMESA" },
    ]

    const availability = await browserAvailability("user_1", {})

    expect(availability.local.available).toBe(true)
    expect(availability.localDevices).toEqual([
      { id: "device-2", name: "SOBREMESA" },
    ])
  })
})
