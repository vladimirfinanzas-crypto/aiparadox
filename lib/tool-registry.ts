// ---------------------------------------------------------------------------
// Tool Registry — the single catalogue of what Godfather is allowed to call.
//
// Every tool group in the product registers itself here once, with the facts
// the rest of the system needs:
//
//   - which integration actually backs it (Browserbase, Zernio, Resend, the
//     local Desktop Agent, Paradox itself),
//   - what it may touch (permissions) and how risky it is,
//   - whether the person has to confirm before it runs,
//   - how long one call may take,
//   - which environment variable must be present for it to work at all.
//
// Two consumers read it: the chat task (trigger/chat.ts), which decides which
// tool groups exist for a turn and tells the model what is and is not
// configured, and the integrations surface, which reports the same facts to the
// person. Nothing else may hard-code a tool list: a new integration is added by
// registering its group here and exporting its tools.
// ---------------------------------------------------------------------------

import { hasPausedDevice, isDeviceOnline, listDevices } from "@/lib/desktop-devices"

export type ToolGroupId =
  | "sandbox"
  | "workspace"
  | "browser"
  | "computer"
  | "social"
  | "email"
  | "router"
  | "routing"

export type ToolRisk = "low" | "medium" | "high"

/** Where a tool group can execute. "any" means the group decides per call. */
export type ToolEnvironment = "cloud" | "local"

export type ToolResultType =
  | "text"
  | "structured"
  | "image"
  | "ack"

export type ToolGroup = {
  id: ToolGroupId
  /** What the person sees, e.g. "Cloud browser". */
  label: string
  /** The service behind the group, e.g. "Browserbase + Playwright". */
  integration: string
  /** Exact tool names this group contributes to Godfather. */
  tools: string[]
  /** What the group is allowed to act on. */
  permissions: string[]
  /** How much damage a wrong call can do. */
  risk: ToolRisk
  /**
   * True when the person must confirm the concrete action before it runs.
   * High-risk groups say so in their tool description as well: the model asks
   * in the conversation, and the backend still validates every call.
   */
  requiresApproval: boolean
  /** Budget for one call, in milliseconds. */
  timeoutMs: number
  /** Environment variables that must be set; empty means "always present". */
  requiredEnv: string[]
  /** What Godfather tells the person when the group is unavailable. */
  unavailableHint: string
  /** Environments this group can run in. Absent means "not browser-scoped". */
  environments?: ToolEnvironment[]
  /** What a successful call returns, so the model knows what to expect. */
  resultType?: ToolResultType
  /** How Godfather checks that a call actually did what it claims. */
  verification?: string
  /** Internal plumbing: registered, never shown in the availability report. */
  internal?: boolean
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    id: "sandbox",
    label: "Godfather's own computer",
    integration: "Daytona sandbox",
    tools: [
      "bash",
      "readFile",
      "writeFile",
      "listFiles",
      "recall",
      "remember",
      "mouseClick",
      "mouseMove",
      "mouseDrag",
      "mouseScroll",
      "keyboardType",
      "keyboardPress",
      "viewScreen",
      "showScreen",
    ],
    permissions: ["files in its own sandbox", "shell inside its own sandbox"],
    risk: "medium",
    requiresApproval: false,
    timeoutMs: 120_000,
    requiredEnv: [],
    unavailableHint:
      "The sandbox hours for this billing period are used up, so shell and file tools are off until the period resets.",
  },
  {
    id: "workspace",
    label: "Panels and automations",
    integration: "Paradox workspace",
    tools: [
      "panel_list",
      "panel_get",
      "panel_create",
      "panel_update",
      "panel_publish",
      "automation_list",
      "automation_create",
      "automation_run",
    ],
    permissions: ["this person's panels", "this person's automations"],
    risk: "medium",
    requiresApproval: false,
    timeoutMs: 30_000,
    requiredEnv: [],
    unavailableHint: "",
  },
  {
    id: "browser",
    label: "Browser",
    integration: "Browserbase + Playwright",
    tools: [
      "browser_navigate",
      "browser_read",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_back",
      "browser_tabs",
      "browser_select_tab",
      "browser_screenshot",
    ],
    permissions: ["a browser session in the environment the task chose", "pages that session opens"],
    risk: "medium",
    // Submitting a form or buying something in the browser is consequential:
    // the tool description makes Godfather confirm those before acting.
    requiresApproval: true,
    timeoutMs: 45_000,
    // This is the *cloud* route's requirement. The local route needs a linked
    // computer instead, which is a per-account question answered by
    // describeAvailableTools (and by browserAvailability).
    requiredEnv: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"],
    environments: ["cloud", "local"],
    resultType: "structured",
    verification:
      "Every navigation, click and keystroke answers with the page that followed it (url, title, visible text and tabs); read that answer before claiming a step worked.",
    unavailableHint:
      "neither browser environment is available — configure Browserbase in Integrations, or install and link Paradox Desktop Agent on the computer to use",
  },
  {
    id: "router",
    label: "Task routing",
    integration: "Paradox execution router",
    tools: ["request_execution_environment"],
    permissions: ["asking where a task should run"],
    risk: "low",
    requiresApproval: false,
    timeoutMs: 15_000,
    requiredEnv: [],
    environments: ["cloud", "local"],
    resultType: "structured",
    verification:
      "A task in awaiting_execution_environment has opened no page: the browser tools refuse to run until the person answers.",
    internal: true,
    unavailableHint: "",
  },
  {
    id: "computer",
    label: "The person's computer",
    integration: "Paradox Desktop Agent (local, PyAutoGUI)",
    tools: [
      "pc_screenshot",
      "pc_move",
      "pc_click",
      "pc_type",
      "pc_press",
      "pc_hotkey",
      "pc_scroll",
      "pc_run",
      "pc_setup",
    ],
    permissions: [
      "the enrolled device's screen, mouse and keyboard",
      "launching allow-listed desktop applications",
    ],
    risk: "high",
    requiresApproval: true,
    timeoutMs: 120_000,
    requiredEnv: [],
    unavailableHint:
      "no computer is online for this account — the person installs and links Paradox Desktop Agent in Settings → Desktop Agent",
  },
  {
    id: "social",
    label: "Social publishing",
    integration: "Zernio",
    tools: ["social_accounts", "social_connect", "social_publish", "social_status"],
    permissions: ["the social accounts this person connected", "posts they author"],
    risk: "high",
    requiresApproval: true,
    timeoutMs: 30_000,
    requiredEnv: ["ZERNIO_API_KEY"],
    unavailableHint:
      "social publishing is not configured (ZERNIO_API_KEY), so posts cannot be created — connect Zernio in Integrations",
  },
  {
    id: "email",
    label: "Email",
    integration: "Resend",
    tools: ["email_send"],
    permissions: ["outbound email through the configured Resend domain"],
    risk: "high",
    requiresApproval: true,
    timeoutMs: 30_000,
    requiredEnv: ["RESEND_API_KEY"],
    unavailableHint:
      "email is not configured (RESEND_API_KEY), so no mail can be sent — connect Resend in Integrations",
  },
  {
    id: "routing",
    label: "Internal delegation",
    integration: "Paradox (internal)",
    tools: ["handoff"],
    permissions: ["passing the turn to another specialist agent of this account"],
    risk: "low",
    requiresApproval: false,
    timeoutMs: 5_000,
    requiredEnv: [],
    resultType: "ack",
    internal: true,
    unavailableHint: "",
  },
] as const

/** The group a tool belongs to, or undefined for an unknown name. */
export function groupForTool(toolName: string): ToolGroup | undefined {
  return TOOL_GROUPS.find((group) => group.tools.includes(toolName))
}

/** Every tool name the registry knows about, in group order. */
export function registeredToolNames(): string[] {
  return TOOL_GROUPS.flatMap((group) => group.tools)
}

export type GroupAvailability = {
  id: ToolGroupId
  available: boolean
  /** Why it is unavailable, phrased for the model. Empty when available. */
  reason: string
}

// Which secrets the server can see, as booleans. The values themselves never
// leave the server — this is the same test the Integrations page reports.
function hasEnv(value: string | undefined) {
  return Boolean(value && value.trim().length > 0)
}

/**
 * Availability of every group from configuration alone. The `computer` group is
 * always *registered* (pc_setup explains how to connect one) — whether a device
 * is actually online is a per-account question, answered by
 * `describeAvailableTools`.
 */
export function getToolAvailability(
  env: Record<string, string | undefined> = process.env
): Record<ToolGroupId, GroupAvailability> {
  const envOk = (group: ToolGroup) =>
    group.requiredEnv.every((name) => hasEnv(env[name]))

  const result = {} as Record<ToolGroupId, GroupAvailability>

  for (const group of TOOL_GROUPS) {
    const available = envOk(group)
    result[group.id] = {
      id: group.id,
      available,
      reason: available ? "" : group.unavailableHint,
    }
  }

  return result
}

/**
 * The paragraph Godfather is told every turn: which integrations it can use
 * right now, and which ones are missing and why. When something is not
 * configured the model must say so instead of pretending an action ran.
 */
export function formatAvailabilityReport(
  availability: Record<ToolGroupId, GroupAvailability>,
  {
    onlineDevices,
    localBrowser = false,
  }: { onlineDevices: number; localBrowser?: boolean }
): string {
  const group = (id: ToolGroupId) =>
    TOOL_GROUPS.find((entry) => entry.id === id) as ToolGroup

  const configured = TOOL_GROUPS.filter(
    (entry) =>
      !entry.internal &&
      (availability[entry.id].available ||
        (entry.id === "browser" && localBrowser))
  ).map((entry) => {
    const tools = entry.tools.join(", ")
    if (entry.id === "computer") {
      return onlineDevices > 0
        ? `- ${entry.integration}: AVAILABLE (${onlineDevices} device${onlineDevices === 1 ? "" : "s"} online, ${tools})`
        : null
    }
    if (entry.id === "browser" && !availability.browser.available) {
      return `- ${entry.integration}: AVAILABLE THROUGH THE PERSON'S PC only (${tools}); the cloud browser (Browserbase) is not configured`
    }
    return `- ${entry.integration}: AVAILABLE (${tools})`
  }).filter(Boolean) as string[]

  const missing = TOOL_GROUPS.filter(
    (entry) =>
      !entry.internal &&
      entry.id !== "computer" &&
      !availability[entry.id].available &&
      !(entry.id === "browser" && localBrowser)
  ).map(
    (entry) =>
      `- ${group(entry.id).integration}: NOT CONFIGURED — ${availability[entry.id].reason}`
  )

  if (onlineDevices === 0) {
    const reason = availability.computer.reason || group("computer").unavailableHint
    missing.push(`- ${group("computer").integration}: NO DEVICE ONLINE — ${reason}`)
  }

  return [
    "Your tools right now, from the registry (availability is checked on the server before every turn):",
    ...configured,
    ...missing,
    missing.length > 0
      ? "For anything marked NOT CONFIGURED or NO DEVICE ONLINE: say plainly that the integration is not connected and what the person has to connect or install. Never claim an action succeeded when its tool was unavailable."
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

/**
 * Availability for one account: configuration plus whether this person has a
 * computer listening. Used by the chat task for the paragraph above.
 */
export async function describeAvailableTools(
  userId: string,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  const availability = getToolAvailability(env)

  let onlineDevices = 0
  let localBrowser = false
  try {
    const devices = await listDevices(userId)
    const online = devices.filter(
      (device) => device.status === "online" && isDeviceOnline(device)
    )
    onlineDevices = online.length
    localBrowser = online.some((device) =>
      device.capabilities.includes("browser")
    )

    if (onlineDevices === 0 && (await hasPausedDevice(userId))) {
      availability.computer = {
        id: "computer",
        available: false,
        reason:
          "the person paused their Desktop Agent, so no local action runs until they resume it in Settings → Desktop Agent",
      }
    }

    // The local browser route needs no Browserbase key: a linked computer with
    // the browser engine is its own way to browse.
    if (localBrowser && !availability.browser.available) {
      availability.browser = { id: "browser", available: true, reason: "" }
    }
  } catch {
    // No database, no devices — reported as "no device online" below
    onlineDevices = 0
    localBrowser = false
  }

  return formatAvailabilityReport(availability, {
    onlineDevices,
    localBrowser,
  })
}
