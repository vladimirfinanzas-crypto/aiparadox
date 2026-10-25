// The catalogue of blocks an automation can be built from.
//
// This file is the single source of truth for *what a block is*: its type, the
// fields it needs, what it produces, where it can run and what it touches
// outside Paradox. It is deliberately pure (no React, no icons) so the server,
// the validator, the engine and the model tools all agree without importing the
// canvas.

export type AutomationNodeType =
  | "start"
  | "open-url"
  | "act"
  | "extract"
  | "observe"
  | "agent"
  | "send-email"
  | "publish-social"
  | "desktop-action"
  | "condition"
  | "delay"

export type NodeKind = "trigger" | "action" | "condition"

/** Where a block is allowed to run. Anything touching the person's computer is
 *  local; the cloud cannot reach their files or their windows. */
export type NodeEnvironment = "cloud" | "local" | "any"

export type NodeFieldSpec = {
  key: string
  label: string
  placeholder?: string
  multiline?: boolean
  required?: boolean
}

export type NodeOutputSpec = {
  path: string
  label: string
}

export type NodeCatalogEntry = {
  type: AutomationNodeType
  label: string
  kind: NodeKind
  /** One line, shown in the palette and to Godfather. */
  description: string
  environment: NodeEnvironment
  fields: NodeFieldSpec[]
  outputs: NodeOutputSpec[]
  /** External effects, in the person's language. A flow with any of these
   *  needs an explicit approval before it may run on its own. */
  effects: string[]
  /** Environment variables that must exist for the block to work at all. */
  requires?: string[]
}

export const nodeCatalog = {
  start: {
    type: "start",
    label: "Start",
    kind: "trigger",
    description: "Marks the entry point. Every flow has exactly one.",
    environment: "any",
    fields: [],
    outputs: [],
    effects: [],
  },
  "open-url": {
    type: "open-url",
    label: "Open URL",
    kind: "action",
    description: "Opens a page in the cloud browser.",
    environment: "cloud",
    fields: [
      { key: "url", label: "URL", placeholder: "https://example.com", required: true },
    ],
    outputs: [
      { path: "url", label: "URL" },
      { path: "title", label: "Title" },
    ],
    effects: ["navega por la web en la nube"],
    requires: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"],
  },
  act: {
    type: "act",
    label: "Act",
    kind: "action",
    description: "Performs one instruction on the open page.",
    environment: "cloud",
    fields: [
      {
        key: "instruction",
        label: "Instruction",
        placeholder: "Click the sign in button",
        multiline: true,
        required: true,
      },
    ],
    outputs: [
      { path: "success", label: "Success" },
      { path: "message", label: "Message" },
      { path: "url", label: "URL" },
    ],
    effects: ["actúa sobre una página web"],
    requires: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"],
  },
  extract: {
    type: "extract",
    label: "Extract",
    kind: "action",
    description: "Reads structured data from the page.",
    environment: "cloud",
    fields: [
      {
        key: "instruction",
        label: "Instruction",
        placeholder: "Extract the product price",
        multiline: true,
        required: true,
      },
    ],
    outputs: [{ path: "extraction", label: "Extraction" }],
    effects: ["lee datos de una página web"],
    requires: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"],
  },
  observe: {
    type: "observe",
    label: "Observe",
    kind: "action",
    description: "Lists the elements on the page that match an instruction.",
    environment: "cloud",
    fields: [
      {
        key: "instruction",
        label: "Instruction",
        placeholder: "Find the sign in button",
        multiline: true,
        required: true,
      },
    ],
    outputs: [
      { path: "matches", label: "Matches" },
      { path: "matches[0].selector", label: "Selector" },
      { path: "matches[0].description", label: "Description" },
    ],
    effects: ["lee datos de una página web"],
    requires: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"],
  },
  agent: {
    type: "agent",
    label: "Agent",
    kind: "action",
    description: "Lets the model drive the browser to complete a goal.",
    environment: "cloud",
    fields: [
      {
        key: "instruction",
        label: "Instruction",
        placeholder: "Search for the stock price of NVDA",
        multiline: true,
        required: true,
      },
    ],
    outputs: [
      { path: "success", label: "Success" },
      { path: "message", label: "Message" },
      { path: "completed", label: "Completed" },
    ],
    effects: ["navega por la web en la nube"],
    requires: [
      "BROWSERBASE_API_KEY",
      "BROWSERBASE_PROJECT_ID",
      "OPENROUTER_API_KEY",
    ],
  },
  "send-email": {
    type: "send-email",
    label: "Send Email",
    kind: "action",
    description: "Sends an email from the Paradox address.",
    environment: "cloud",
    fields: [
      { key: "to", label: "To", placeholder: "person@example.com", required: true },
      { key: "subject", label: "Subject", placeholder: "Hello", required: true },
      {
        key: "body",
        label: "Body",
        placeholder: "Write your message…",
        multiline: true,
        required: true,
      },
    ],
    outputs: [{ path: "id", label: "Email ID" }],
    effects: ["envía un correo electrónico"],
    requires: ["RESEND_API_KEY"],
  },
  "publish-social": {
    type: "publish-social",
    label: "Publish to Social",
    kind: "action",
    description: "Publishes or schedules a post on connected networks.",
    environment: "cloud",
    fields: [
      {
        key: "content",
        label: "Post",
        placeholder: "What to publish…",
        multiline: true,
        required: true,
      },
      {
        key: "platforms",
        label: "Networks",
        placeholder: "twitter, linkedin",
        required: true,
      },
      {
        key: "scheduledFor",
        label: "Publish at (optional)",
        placeholder: "2027-01-01T12:00:00",
      },
      { key: "timezone", label: "Timezone", placeholder: "Europe/Madrid" },
      { key: "accountId", label: "Account id (optional)" },
    ],
    outputs: [
      { path: "postId", label: "Post ID" },
      { path: "status", label: "Status" },
      { path: "links", label: "Links" },
    ],
    effects: ["publica contenido en redes sociales"],
    requires: ["ZERNIO_API_KEY"],
  },
  "desktop-action": {
    type: "desktop-action",
    label: "Desktop Action",
    kind: "action",
    description: "One mouse, keyboard or program action on the person's computer.",
    environment: "local",
    fields: [
      {
        key: "action",
        label: "Action",
        placeholder: "click",
        required: true,
      },
      {
        key: "value",
        label: "Value",
        placeholder: "Text, key, shortcut or program",
      },
      { key: "x", label: "X (pixels)" },
      { key: "y", label: "Y (pixels)" },
    ],
    outputs: [{ path: "result", label: "Result" }],
    effects: ["controla el equipo del usuario"],
  },
  condition: {
    type: "condition",
    label: "Condition",
    kind: "condition",
    description:
      "Splits the flow. The true branch runs when the expression holds; the false branch otherwise.",
    environment: "any",
    fields: [
      {
        key: "expression",
        label: "Condition",
        placeholder: '{{ read.extraction }} contains "error"',
        multiline: true,
        required: true,
      },
    ],
    outputs: [{ path: "result", label: "Result" }],
    effects: [],
  },
  delay: {
    type: "delay",
    label: "Wait",
    kind: "action",
    description: "Waits, durably, before continuing. The run keeps its place.",
    environment: "any",
    fields: [
      {
        key: "seconds",
        label: "Seconds",
        placeholder: "60",
        required: true,
      },
    ],
    outputs: [],
    effects: [],
  },
} satisfies Record<AutomationNodeType, NodeCatalogEntry>

export const nodeTypes = Object.keys(nodeCatalog) as AutomationNodeType[]

export function catalogFor(type: string): NodeCatalogEntry | undefined {
  return (nodeCatalog as Record<string, NodeCatalogEntry>)[type]
}

/** Node types the engine runs as a step (the trigger and the stop markers are
 *  handled by the engine itself, not by an executor). */
export const executableNodeTypes = nodeTypes.filter(
  (type) => nodeCatalog[type].kind === "action"
)

/** External effects of a definition, in order, without duplicates. */
export function effectsOf(
  nodes: ReadonlyArray<{ type: string }>
): string[] {
  const seen = new Set<string>()
  for (const node of nodes) {
    for (const effect of catalogFor(node.type)?.effects ?? []) seen.add(effect)
  }
  return [...seen]
}

/** True when any block needs the person's own computer. */
export function needsLocalEnvironment(
  nodes: ReadonlyArray<{ type: string }>
): boolean {
  return nodes.some((node) => catalogFor(node.type)?.environment === "local")
}

/** True when any block runs in Paradox's cloud. */
export function needsCloudEnvironment(
  nodes: ReadonlyArray<{ type: string }>
): boolean {
  return nodes.some((node) => catalogFor(node.type)?.environment === "cloud")
}

export type AutomationExecutionTarget = "cloud" | "local" | "hybrid"

export function executionTargetOf(
  nodes: ReadonlyArray<{ type: string }>
): AutomationExecutionTarget {
  const local = needsLocalEnvironment(nodes)
  const cloud = needsCloudEnvironment(nodes)
  if (local && cloud) return "hybrid"
  if (local) return "local"
  return "cloud"
}

/** Whether the block has consequences outside Paradox and so needs a review. */
export function hasExternalEffects(type: string): boolean {
  return (catalogFor(type)?.effects.length ?? 0) > 0
}
