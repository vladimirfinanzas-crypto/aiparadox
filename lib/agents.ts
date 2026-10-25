import type { AgentKind, Bot, NewBot } from "@/db/schema"

// Every kind of agent the product ships, and what that implies for the tools it
// gets in a conversation. The chat router reads this too, so it knows which
// kinds can be sent a given task.
export const agentKinds = {
  chat: {
    label: "Chat",
    summary: "Talks, remembers across conversations, structures its answers.",
    capabilities: ["Conversations", "Memory", "Structured output"],
  },
  browser: {
    label: "Browser",
    summary:
      "Drives a cloud browser with Playwright: navigate, click, type, read, capture.",
    capabilities: ["Navigate", "Click & type", "Extract", "Screenshot"],
  },
  computer: {
    label: "PC",
    summary:
      "Controls a desktop with PyAutoGUI — the agent installed on a computer, or your cloud desktop.",
    capabilities: ["Mouse", "Keyboard", "Screen", "Apps"],
  },
  social: {
    label: "Social",
    summary:
      "Publishes and tracks posts across 16 networks through one API.",
    capabilities: ["Schedule", "Publish", "Media", "Analytics"],
  },
} satisfies Record<AgentKind, { label: string; summary: string; capabilities: string[] }>

export type AgentKindInfo = (typeof agentKinds)[AgentKind]

// The orchestrator that fronts every conversation. It is a real agent (kind
// `chat`, so it gets a sandbox of its own and can analyse images, documents and
// PDFs the person sends), but it is hidden from the Agents section and is the
// entry point of every direct chat: it welcomes the person, understands the
// request, and coordinates the specialist agents to deliver the result. The
// trigger and the router read `role: "orchestrator"` to give it the whole
// catalogue and the front seat.
export const ORCHESTRATOR_ROLE = "orchestrator"

// The hidden orchestrator is a member of every direct chat, but it is not the
// agent the person came to talk to, so it always goes last in a list of
// members: the header, the sidebar and the desktop panel follow the first one.
export function sortBotsByVisibility<T extends { role?: string | null }>(
  members: T[]
): T[] {
  return [...members].sort(
    (a, b) =>
      (a.role === ORCHESTRATOR_ROLE ? 1 : 0) -
      (b.role === ORCHESTRATOR_ROLE ? 1 : 0)
  )
}

// The name of an agent as the person sees it, compared without regard to case
// or surrounding spaces. It is the same rule the database enforces on
// `(user_id, name)`, so the checks in the app and the constraint in the
// database always agree.
export function normalizeName(name: string) {
  return name.trim().toLowerCase()
}

// The name the orchestrator row takes on an account. It is "Godfather" unless
// the person already uses that name for one of their own agents, in which case
// a free variant is used: the orchestrator is identified by its role, not by
// its name, but two agents of one account may not share a name.
export function orchestratorName(taken: string[]) {
  const used = new Set(taken.map(normalizeName))
  if (!used.has(normalizeName(godfather.name))) return godfather.name
  const variant = `${godfather.name} (Orchestrator)`
  if (!used.has(normalizeName(variant))) return variant
  for (let n = 2; ; n++) {
    const numbered = `${variant} ${n}`
    if (!used.has(normalizeName(numbered))) return numbered
  }
}

// The team the orchestrator can hand work to, in one line. It is built from
// the agents the account actually has, so it can never go stale against the
// catalogue: a renamed, added or deleted agent changes this without anyone
// having to remember to edit a prompt.
export function describeRoster(agents: { name: string; job: string }[]) {
  if (agents.length === 0) return ""
  return agents.map((agent) => `${agent.name} (${agent.job})`).join(", ")
}

export const godfather: Omit<NewBot, "userId"> = {
  name: "Godfather",
  job: "Orchestrator of all agents",
  kind: "chat",
  source: "default",
  role: ORCHESTRATOR_ROLE,
  hidden: true,
  outputFormat: "markdown",
  // The team itself is not written here: the roster is added to the prompt at
  // runtime from the account's own agents, so this row stays true no matter
  // what the person has added, renamed or removed.
  instructions:
    "You are the orchestrator of a team of AI agents. The person talks to you; you understand the request, decide who does the work, and deliver the result. You have every capability at your disposal: a sandbox with shell and file tools (read, write, list), a cloud browser (Playwright), desktop control (PyAutoGUI through the pc_* tools) and social publishing (the social_* tools). Analyse anything the person sends — text, images, documents, PDFs — by reading them in your sandbox with bash (pdftotext, python) or by looking at them directly when they are images. When a request clearly belongs to a specialist, use the handoff tool to pass it on with a short brief, then present their result as the team's answer; otherwise do the work yourself. Always answer in the language the person writes in.",
}

// The catalogue every account starts with. These rows are inserted per person
// the first time their agents are read, so each person can edit theirs without
// changing anyone else's.
//
// None of them owns a sandbox: they run on the APIs behind their kind. A bot a
// person creates themselves still gets a computer of its own.
export const defaultAgents: Omit<NewBot, "userId">[] = [
  {
    name: "Aria",
    job: "General assistant",
    kind: "chat",
    source: "default",
    outputFormat: "markdown",
    instructions:
      "You are the default assistant. Answer in the language the person writes in (Spanish or English). Be direct: give the answer first, then the reasoning only if it helps. When they ask for something structured — a list, a table, JSON, an email — return exactly that shape and nothing around it. Call recall before answering anything about the person or their earlier work.",
  },
  {
    name: "Voyager",
    job: "Browser automation",
    kind: "browser",
    source: "default",
    outputFormat: "markdown",
    instructions:
      "You operate a real cloud browser. Work in small, verifiable steps: open a page, look at what is there, act, then look again. Prefer reading what is on screen over guessing. Report the URL you ended on and quote the values you extracted. Never claim a step succeeded without observing it.",
  },
  {
    name: "Titan",
    job: "Desktop control",
    kind: "computer",
    source: "default",
    outputFormat: "markdown",
    instructions:
      "You control a desktop computer. Look at the screen before every action and again afterwards to confirm what changed. Prefer keyboard shortcuts over hunting for buttons. Ask before anything destructive or irreversible: deleting files, sending messages, purchases, or changing system settings.",
  },
  {
    name: "Musa",
    job: "Social media",
    kind: "social",
    source: "default",
    outputFormat: "table",
    instructions:
      "You plan and publish social posts. Match each network's conventions: length, hashtags, format. Draft first, show what will be posted where, and confirm before publishing. When scheduling, state the time and the timezone explicitly. Return a table of what was created with its status and link.",
  },
  {
    name: "Lumen",
    job: "Data and reports",
    kind: "chat",
    source: "default",
    outputFormat: "json",
    instructions:
      "You turn messy input into structured output. Default to JSON with stable keys unless asked otherwise. If something is missing, use null rather than guessing, and list every assumption you made in an `assumptions` array.",
  },
  {
    name: "Orion",
    job: "Research assistant",
    kind: "chat",
    source: "default",
    outputFormat: "markdown",
    instructions:
      "You help research topics by gathering information from available sources, structuring findings, and providing concise summaries with citations. Always verify facts and mention your sources.",
  },
  {
    name: "Cipher",
    job: "Code assistant",
    kind: "computer",
    source: "default",
    outputFormat: "markdown",
    instructions:
      "You write, review, and refactor code. Follow best practices and style conventions. When suggesting changes, explain why and show diffs. Always include working code examples.",
  },
  {
    name: "Nexus",
    job: "Social media manager",
    kind: "social",
    source: "default",
    outputFormat: "table",
    instructions:
      "You manage across 16 networks through the Zernio API. Help plan campaigns, schedule posts, track engagement metrics, and respond to comments. Match each network's conventions for length, hashtags, and format. Return a summary table of what was posted where with links and performance data.",
  },
]

// The shape the AI agent builder is asked to produce from a free-text brief
export type AgentDraft = {
  name: string
  job: string
  kind: AgentKind
  instructions: string
  outputFormat: "markdown" | "json" | "table" | "email" | "plain"
}

export type { Bot }
