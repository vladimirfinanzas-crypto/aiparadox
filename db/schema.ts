import type { Edge } from "@xyflow/react"
import { relations, sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { createInsertSchema } from "drizzle-zod"
import { nanoid } from "nanoid"
import { z } from "zod"

import type { StepNodeType } from "@/features/workflows/nodes/node-registry"
import type { AutomationDefinition } from "@/lib/automations/definition"
import type { PanelDocument } from "@/lib/panels/document"

// ---------------------------------------------------------------------------
// Workflows — the block-programming section. Same shape as React Flow's own
// graph so the runner reads it without remapping. Re-scoped from the source
// app's Clerk organization to the signed-in user, so all three sections share
// one identity.
// ---------------------------------------------------------------------------
export type WorkflowGraph = { nodes: StepNodeType[]; edges: Edge[] }

// The lifecycle of the automation itself. A failed run never changes it: the
// state of a flow and the state of one execution are different things.
export type AutomationStatus =
  | "draft"
  | "pending_approval"
  | "active"
  | "paused"
  | "error"

export type AutomationExecutionTarget = "cloud" | "local" | "hybrid"

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Clerk user ID
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").$type<AutomationStatus>().notNull().default("draft"),
    // The structured flow. `graph` is the pre-v2 shape, kept until the
    // definition is verified and the migration closes.
    definition: jsonb("definition").$type<AutomationDefinition>(),
    graph: jsonb("graph").$type<WorkflowGraph>(),
    version: integer("version").notNull().default(1),
    executionTarget: text("execution_target")
      .$type<AutomationExecutionTarget>()
      .notNull()
      .default("cloud"),
    timezone: text("timezone").notNull().default("UTC"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("workflows_user_id_idx").on(table.userId),
    index("workflows_user_updated_idx").on(table.userId, table.updatedAt),
    index("workflows_status_next_run_idx").on(table.status, table.nextRunAt),
  ]
)

export type Workflow = typeof workflows.$inferSelect

// ---------------------------------------------------------------------------
// Agents — what the whole product runs on. The table keeps the name it was
// born with (`bots`) so the chat machinery is untouched, but every row is an
// agent: a model plus the skills/tools it may call.
// ---------------------------------------------------------------------------

// What the agent drives. `chat` owns a Daytona sandbox; the other three are
// backed by APIs and never get one.
export const agentKind = pgEnum("agent_kind", [
  "chat",
  "browser",
  "computer",
  "social",
])

// Where the row came from: the SaaS catalogue, the person, or the AI builder
export const agentSource = pgEnum("agent_source", ["default", "user", "ai"])

export const bots = pgTable(
  "bots",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => nanoid()),
    // Clerk user ID
    userId: text().notNull(),
    name: text().notNull(),
    // Seed for the bot's face
    avatar: text()
      .notNull()
      .$defaultFn(() => nanoid()),
    // What the bot is for, in a phrase
    job: text().notNull(),
    // How it should go about the job
    instructions: text(),
    // Daytona sandbox ID. Only `chat` agents have one, and it is created with
    // the agent and deleted with it.
    sandboxId: text(),
    // Which of the product's three capabilities (plus plain chat) this agent
    // owns. Picked for the user by the router in the Chat section.
    kind: agentKind().notNull().default("chat"),
    // Whether it ships with the SaaS or was made by the person / the AI
    source: agentSource().notNull().default("user"),
    // Model this agent runs on; null means the product default
    model: text(),
    // How its answer is shaped for the client
    outputFormat: text()
      .notNull()
      .default("markdown"),
    // Skill/tool allowlist. Null means "everything this kind can do".
    tools: jsonb().$type<string[]>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // The orchestrator ("Godfather") is a real agent per account, but it never
    // shows in the Agents section: it lives in the chat as the entry point that
    // welcomes the person and coordinates the other agents.
    hidden: boolean().notNull().default(false),
    // "orchestrator" marks the one agent that fronts every conversation and can
    // reach the whole catalogue. Null/undefined means an ordinary agent.
    role: text(),
  },
  (table) => [
    index("bots_user_id_idx").on(table.userId),
    // Two agents of one account may not share a name: the person picks them
    // apart by name, and the router reads the name to decide who does what.
    // Case- and space-insensitive, so "Aria" and "aria " are the same name.
    uniqueIndex("bots_user_id_name_unique").on(table.userId, sql`lower(btrim(${table.name}))`),
  ]
)

// ---------------------------------------------------------------------------
// Chats — unchanged from the chat app: direct (one agent) and group (several,
// with handoffs between them).
// ---------------------------------------------------------------------------
export const chatKind = pgEnum("chat_kind", ["direct", "group"])

export const chats = pgTable(
  "chats",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => nanoid()),
    // Clerk user ID
    userId: text().notNull(),
    kind: chatKind().notNull().default("direct"),
    // Null for direct chats, which use the bot's name
    name: text(),
    lastMessagePreview: text(),
    lastMessageAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("chats_user_id_idx").on(table.userId)]
)

export const chatMembers = pgTable(
  "chat_members",
  {
    chatId: text()
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    botId: text()
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.botId] }),
    index("chat_members_bot_id_idx").on(table.botId),
  ]
)

// ---------------------------------------------------------------------------
// Usage — an append-only ledger. One row per metered event; what a person has
// used in a billing period is the sum of their rows since it started.
// ---------------------------------------------------------------------------
export const usageKind = pgEnum("usage_kind", [
  "ai",
  "sandbox",
  "browser",
  "social",
])

export const usageEntries = pgTable(
  "usage_entries",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => nanoid()),
    // Clerk user ID
    userId: text().notNull(),
    kind: usageKind().notNull(),
    // Millionths of a dollar of model spend for "ai", seconds a resource was
    // running for the metered kinds
    amount: integer().notNull(),
    // Names the event that was metered, so writing it twice counts it once
    idempotencyKey: text().notNull().unique(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("usage_entries_user_id_created_at_idx").on(
      table.userId,
      table.createdAt
    ),
  ]
)

// ---------------------------------------------------------------------------
// Integrations — the per-person handles the three API-backed agents need.
// One row per person, created on demand.
// ---------------------------------------------------------------------------
export const integrations = pgTable("integrations", {
  // Clerk user ID
  userId: text().primaryKey(),
  // Zernio profile that owns this person's connected social accounts
  zernioProfileId: text(),
  // Bearer token the person's local PyAutoGUI agent authenticates with
  pcAgentToken: text().$defaultFn(() => nanoid(32)),
  pcAgentStatus: text().notNull().default("offline"),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

export type Integration = typeof integrations.$inferSelect

// ---------------------------------------------------------------------------
// PC jobs — how a conversation reaches a computer the person installed the
// local PyAutoGUI agent on. The tool writes a job here; the local agent polls
// for it over HTTPS with its own token, performs the action and posts the
// result back. Nothing has to connect *into* the person's machine, so there is
// no port to open and no VPN.
// ---------------------------------------------------------------------------
export const pcJobStatus = pgEnum("pc_job_status", [
  "pending",
  "claimed",
  "done",
  "failed",
])

// One instruction the desktop must carry out. Deliberately small: the agent
// composes complex work from these instead of shipping executable code.
//
// The browser_* kinds drive the browser the agent opens on the person's own
// machine. `sessionKey` is the execution task id, so two tasks on the same
// computer never share a window, a tab or a profile. `pageId` names the tab the
// action applies to — the agent never guesses "the active tab".
export type PcAction =
  | { kind: "screenshot" }
  | { kind: "move"; x: number; y: number }
  | { kind: "click"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { kind: "type"; text: string }
  | { kind: "press"; key: string }
  | { kind: "hotkey"; keys: string[] }
  | { kind: "scroll"; dx: number; dy: number }
  | { kind: "run"; command: string; args?: string[] }
  | { kind: "browser_open"; sessionKey: string; url?: string }
  | { kind: "browser_navigate"; sessionKey: string; url: string; pageId?: string }
  | { kind: "browser_read"; sessionKey: string; pageId?: string }
  | { kind: "browser_tabs"; sessionKey: string }
  | { kind: "browser_select_tab"; sessionKey: string; pageId: string }
  | { kind: "browser_click"; sessionKey: string; pageId?: string; target: string }
  | {
      kind: "browser_type"
      sessionKey: string
      pageId?: string
      target: string
      text: string
      submit?: boolean
    }
  | { kind: "browser_press"; sessionKey: string; pageId?: string; key: string }
  | { kind: "browser_back"; sessionKey: string; pageId?: string }
  | { kind: "browser_screenshot"; sessionKey: string; pageId?: string }
  | { kind: "browser_close"; sessionKey: string }

export const pcJobs = pgTable(
  "pc_jobs",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => nanoid()),
    // Clerk user ID — the computer belongs to this person
    userId: text().notNull(),
    // The exact machine the job is for, when one was chosen. Null means any of
    // the person's computers may claim it (the legacy behaviour).
    deviceId: text(),
    action: jsonb().$type<PcAction>().notNull(),
    status: pcJobStatus().notNull().default("pending"),
    // Screenshot as a data URL, or whatever the action returned
    result: jsonb(),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
  },
  (table) => [index("pc_jobs_user_id_status_idx").on(table.userId, table.status)]
)

export type PcJob = typeof pcJobs.$inferSelect

// ---------------------------------------------------------------------------
// Desktop devices — the computers a person has authorized Godfather to use.
// A device enrolls itself with a short-lived code the person approves in the
// web app, authenticates with its own revocable token, and heartbeats while it
// polls for work. Nothing listens on the machine: the token only lets it claim
// jobs and post their results.
// ---------------------------------------------------------------------------

export const desktopDevices = pgTable(
  "desktop_devices",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => nanoid()),
    // Clerk user ID — the machine belongs to exactly one account
    userId: text().notNull(),
    name: text().notNull(),
    os: text(),
    agentVersion: text(),
    // SHA-256 of the bearer token. The token itself is shown once, at enrollment
    tokenHash: text().notNull().unique(),
    // "online" | "paused" | "revoked"; "offline" is derived from lastSeenAt
    status: text().notNull().default("online"),
    // What the local runtime can do: screen, mouse, keyboard, run
    capabilities: jsonb()
      .$type<string[]>()
      .notNull()
      .default(["screen", "mouse", "keyboard"]),
    lastSeenAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (table) => [index("desktop_devices_user_id_idx").on(table.userId)]
)

export type DesktopDevice = typeof desktopDevices.$inferSelect

// Enrollment sessions: the local agent asks for a code, the person approves it
// while signed in, and the agent exchanges the approved code for its token —
// once, over HTTPS, never through the browser's URL or history.
export const desktopEnrollments = pgTable(
  "desktop_enrollments",
  {
    code: text().primaryKey(),
    // Set when a signed-in person approves the code
    userId: text(),
    deviceName: text(),
    os: text(),
    // "pending" | "approved" | "consumed" | "cancelled"; expiry is expiresAt
    status: text().notNull().default("pending"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    approvedAt: timestamp({ withTimezone: true }),
    consumedAt: timestamp({ withTimezone: true }),
  },
  (table) => [index("desktop_enrollments_status_idx").on(table.status)]
)

export type DesktopEnrollment = typeof desktopEnrollments.$inferSelect

// ---------------------------------------------------------------------------
// Execution tasks — one row per piece of work Godfather runs somewhere other
// than its own sandbox.
//
// The row exists before anything runs, because the person may have to choose
// where the work happens. `awaiting_execution_environment` is a real state: the
// task is created, the question is asked with buttons in the chat, and no
// browser is opened until an environment is recorded. The choice survives a
// page reload (it is a row, not a client detail) and is never changed silently
// afterwards.
// ---------------------------------------------------------------------------

/** Where a task may run: the person's own computer, or the managed cloud. */
export type ExecutionEnvironment = "local" | "cloud"

export type ExecutionTaskStatus =
  | "awaiting_execution_environment"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

// Events are the task's own audit trail: what was decided, what ran, how long
// it took, and how it ended. Content of the pages visited is not stored here.
export type ExecutionTaskEvent = {
  at: string
  /** "environment_selected" | "session_opened" | "step" | "error" | … */
  kind: string
  detail?: string
  durationMs?: number
  tool?: string
}

export const executionTasks = pgTable(
  "execution_tasks",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => nanoid()),
    // Clerk user ID — every read and write is scoped by it
    userId: text().notNull(),
    // The chat the task was asked in, so the card and Activity link back
    conversationId: text(),
    // What the person asked for, in their words, kept for the audit trail
    request: text().notNull(),
    // "local" | "cloud" | null while the person has not chosen
    environment: text().$type<ExecutionEnvironment>(),
    status: text()
      .$type<ExecutionTaskStatus>()
      .notNull()
      .default("awaiting_execution_environment"),
    // Why this environment was chosen, in one line
    reason: text(),
    // The buttons the person was shown, frozen with their disabled flags, so a
    // reloaded card is identical and the decision stays reproducible
    options: jsonb().$type<
      Array<{
        id: string
        label: string
        description?: string
        disabled?: boolean
      }>
    >(),
    // The cloud browser session, when the cloud route ran
    browserSessionId: text(),
    error: text(),
    events: jsonb()
      .$type<ExecutionTaskEvent[]>()
      .notNull()
      .default([]),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp({ withTimezone: true }),
    startedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    index("execution_tasks_user_id_idx").on(table.userId),
    index("execution_tasks_conversation_idx").on(
      table.conversationId,
      table.status
    ),
  ]
)

export type ExecutionTask = typeof executionTasks.$inferSelect

export type { Integration as IntegrationRow }

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------
export const botsRelations = relations(bots, ({ many }) => ({
  memberships: many(chatMembers),
}))

export const chatsRelations = relations(chats, ({ many }) => ({
  members: many(chatMembers),
}))

export const chatMembersRelations = relations(chatMembers, ({ one }) => ({
  chat: one(chats, {
    fields: [chatMembers.chatId],
    references: [chats.id],
  }),
  bot: one(bots, {
    fields: [chatMembers.botId],
    references: [bots.id],
  }),
}))

// ---------------------------------------------------------------------------
// Validation — derived from the Drizzle tables so client and server share one
// set of rules. Anything generated server-side is omitted.
// ---------------------------------------------------------------------------
export const botInsertSchema = createInsertSchema(bots, {
  name: (schema) =>
    schema
      .trim()
      .min(1, "Give your agent a name.")
      .max(50, "Keep it under 50 characters."),
  job: (schema) =>
    schema
      .trim()
      .min(1, "Tell your agent what its job is.")
      .max(100, "Keep it under 100 characters."),
  instructions: (schema) =>
    schema.trim().max(4000, "Keep it under 4000 characters."),
  model: (schema) => schema.trim().max(100, "Keep it under 100 characters."),
  outputFormat: (schema) =>
    schema.trim().max(40, "Keep it under 40 characters."),
}).omit({ id: true, userId: true, sandboxId: true, createdAt: true, source: true })

// What the AI agent builder takes: a free description of what is needed
export const agentBriefSchema = z.object({
  description: z
    .string()
    .trim()
    .min(10, "Describe what the agent should do in a sentence or two.")
    .max(2000, "Keep it under 2000 characters."),
  name: z.string().trim().min(1).max(50).optional(),
})

export type AgentBrief = z.infer<typeof agentBriefSchema>

// A group chat is a name and the bots in it; direct chats are made with their bot
export const groupChatInsertSchema = createInsertSchema(chats, {
  name: z
    .string()
    .trim()
    .min(1, "Give the group a name.")
    .max(50, "Keep it under 50 characters."),
})
  .omit({
    id: true,
    userId: true,
    kind: true,
    lastMessagePreview: true,
    lastMessageAt: true,
    createdAt: true,
  })
  .extend({
    botIds: z.array(z.string()).min(2, "Pick at least two bots."),
  })

export type Bot = typeof bots.$inferSelect
export type NewBot = typeof bots.$inferInsert
export type BotInsert = z.infer<typeof botInsertSchema>
export type AgentKind = (typeof agentKind.enumValues)[number]
export type AgentSource = (typeof agentSource.enumValues)[number]

export type GroupChatInsert = z.infer<typeof groupChatInsertSchema>

export type Chat = typeof chats.$inferSelect
export type NewChat = typeof chats.$inferInsert
export type UsageKind = (typeof usageKind.enumValues)[number]
export type NewUsageEntry = typeof usageEntries.$inferInsert
export type ChatMember = typeof chatMembers.$inferSelect
export type NewChatMember = typeof chatMembers.$inferInsert

// ---------------------------------------------------------------------------
// Widgets — dynamic, user-owned dashboard widgets. Types and configuration
// stay free-form (jsonb) so new widget kinds can be added without a schema
// change. Publication status and ordering live on the row.
// ---------------------------------------------------------------------------
export const widgets = pgTable(
  "widgets",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => nanoid()),
    // Clerk user ID
    userId: text().notNull(),
    name: text().notNull(),
    type: text().notNull(),
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    // The layout version. Runtime data (ticks, rows, typed values) does not
    // bump it: only a structural change does, so history stays readable.
    version: integer().notNull().default(1),
    order: integer().notNull().default(0),
    isPublished: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("widgets_user_id_idx").on(table.userId),
    index("widgets_user_id_order_idx").on(table.userId, table.order),
    index("widgets_user_id_published_idx").on(table.userId, table.isPublished),
  ]
)

export type Widget = typeof widgets.$inferSelect
export type NewWidget = typeof widgets.$inferInsert

export const widgetInsertSchema = createInsertSchema(widgets, {
  name: (schema) =>
    schema
      .trim()
      .min(1, "Give your widget a name.")
      .max(100, "Keep it under 100 characters."),
  type: (schema) =>
    schema
      .trim()
      .min(1, "Pick a widget type.")
      .max(50, "Keep it under 50 characters."),
}).omit({ id: true, userId: true, order: true, isPublished: true, createdAt: true, updatedAt: true })

export type WidgetInsert = z.infer<typeof widgetInsertSchema>

// One frozen layout per structural change, so a panel Godfather rewrote can be
// inspected and reverted without losing the data inside the blocks it kept.
export const widgetVersions = pgTable(
  "widget_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    widgetId: text("widget_id")
      .notNull()
      .references(() => widgets.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    document: jsonb("document").$type<PanelDocument>().notNull(),
    author: text("author")
      .$type<"user" | "godfather" | "migration">()
      .notNull()
      .default("user"),
    summary: text("summary"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("widget_versions_unique").on(table.widgetId, table.version),
    index("widget_versions_widget_idx").on(table.widgetId, table.version),
  ]
)

export type WidgetVersion = typeof widgetVersions.$inferSelect

// ---------------------------------------------------------------------------
// Executions — tracks agent workflow executions with approval flows
// ---------------------------------------------------------------------------

export const executions = pgTable("executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  conversationId: text("conversation_id"),
  panelId: text("panel_id"),
  automationId: text("automation_id"),
  status: text("status").notNull().default("queued"),
  role: text("role").notNull(),
  model: text("model"),
  prompt: text("prompt").notNull(),
  result: text("result"),
  error: text("error"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  approvedAt: timestamp("approved_at"),
  approvalId: uuid("approval_id"),
  toolCalls: integer("tool_calls").default(0),
  tokensUsed: integer("tokens_used"),
  neuronsUsed: integer("neurons_used"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
})

export type Execution = typeof executions.$inferSelect
export type NewExecution = typeof executions.$inferInsert

// ---------------------------------------------------------------------------
// Automations v2 — versions, runs, steps, schedules and approvals.
//
// `workflows` stays the automation row (it is what every existing query and the
// agent's tools already use); these tables hold what the old system kept in
// Trigger.dev only, so the history survives a reload, a redeploy or a closed
// tab. Everything is scoped by `user_id` in the queries, never by the client.
// ---------------------------------------------------------------------------

export const automationVersions = pgTable(
  "automation_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    version: integer("version").notNull(),
    definition: jsonb("definition").$type<AutomationDefinition>().notNull(),
    // Who wrote it: the person in the editor, Godfather, or the graph importer
    author: text("author")
      .$type<"user" | "godfather" | "migration">()
      .notNull()
      .default("user"),
    summary: text("summary"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("automation_versions_unique").on(table.workflowId, table.version),
    index("automation_versions_workflow_idx").on(table.workflowId, table.version),
  ]
)

export type AutomationVersion = typeof automationVersions.$inferSelect

export type AutomationRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked"

export type AutomationRunOrigin = "manual" | "schedule" | "godfather" | "api"

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    // The version that ran, frozen: a later edit cannot rewrite this run
    version: integer("version").notNull().default(1),
    status: text("status").$type<AutomationRunStatus>().notNull().default("queued"),
    origin: text("origin").$type<AutomationRunOrigin>().notNull().default("manual"),
    environment: text("environment")
      .$type<"cloud" | "local" | "hybrid">()
      .notNull()
      .default("cloud"),
    // The Trigger.dev run, once it exists. Unique so a retried enqueue cannot
    // create a second row for the same run.
    triggerRunId: text("trigger_run_id"),
    idempotencyKey: text("idempotency_key"),
    error: text("error"),
    output: jsonb("output").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (table) => [
    uniqueIndex("automation_runs_trigger_run_unique").on(table.triggerRunId),
    uniqueIndex("automation_runs_idempotency_unique").on(table.idempotencyKey),
    index("automation_runs_workflow_idx").on(table.workflowId, table.startedAt),
    index("automation_runs_user_idx").on(table.userId, table.startedAt),
    index("automation_runs_status_idx").on(table.status),
  ]
)

export type AutomationRun = typeof automationRuns.$inferSelect

export type AutomationStepStatus = "pending" | "running" | "done" | "failed" | "skipped"

export const automationRunSteps = pgTable(
  "automation_run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    nodeType: text("node_type").notNull(),
    title: text("title").notNull(),
    status: text("status").$type<AutomationStepStatus>().notNull().default("pending"),
    attempt: integer("attempt").notNull().default(1),
    error: text("error"),
    output: jsonb("output").$type<unknown>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (table) => [index("automation_run_steps_run_idx").on(table.runId, table.startedAt)]
)

export type AutomationRunStep = typeof automationRunSteps.$inferSelect

export const automationSchedules = pgTable(
  "automation_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    kind: text("kind").$type<"cron" | "once">().notNull(),
    cron: text("cron"),
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    triggerScheduleId: text("trigger_schedule_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("automation_schedules_workflow_unique").on(table.workflowId),
    index("automation_schedules_next_run_idx").on(table.enabled, table.nextRunAt),
  ]
)

export type AutomationSchedule = typeof automationSchedules.$inferSelect

export const automationApprovals = pgTable(
  "automation_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    version: integer("version").notNull(),
    // Hash of the consequential parts of the definition (external actions and
    // their settings). Any relevant edit changes it, so the approval stops
    // applying and the flow has to be reviewed again.
    scopeHash: text("scope_hash").notNull(),
    actions: jsonb("actions")
      .$type<Array<{ nodeId: string; type: string; label: string }>>()
      .notNull()
      .default([]),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("automation_approvals_workflow_idx").on(table.workflowId, table.version),
  ]
)

export type AutomationApproval = typeof automationApprovals.$inferSelect

// ---------------------------------------------------------------------------
// Integration centre — per-user configuration of providers and APIs.
//
// Everything here is scoped by `user_id` (Clerk id) and read only through the
// session. Credentials are stored encrypted (`lib/secrets.ts`); the columns
// below never hold a secret in clear text, and no query selects the ciphertext
// into a client payload.
// ---------------------------------------------------------------------------

/** Which AI providers this person enabled, and in what order. */
export const aiProviderSettings = pgTable(
  "ai_provider_settings",
  {
    userId: text("user_id").notNull(),
    // One of PROVIDER_IDS in lib/ai/types.ts
    provider: text("provider").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // Lower wins; the server action rewrites the whole list
    position: integer("position").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.provider] }),
  ]
)

export type AiProviderSetting = typeof aiProviderSettings.$inferSelect
export type NewAiProviderSetting = typeof aiProviderSettings.$inferInsert

/**
 * The model a person chose to lead one role.
 *
 * Only the identity is stored. Capabilities, free tier and the rest of the
 * ladder are read from the catalogue at call time, so a model that is removed
 * from the catalogue — or loses a capability — stops being used instead of being
 * applied on stale facts.
 */
export const aiModelPreferences = pgTable(
  "ai_model_preferences",
  {
    userId: text("user_id").notNull(),
    // 'general' | 'fast' | 'code' | 'reasoner' | 'vision' | 'creative' | 'evaluator'
    role: text("role").notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.role] })]
)

export type AiModelPreference = typeof aiModelPreferences.$inferSelect
export type NewAiModelPreference = typeof aiModelPreferences.$inferInsert

/**
 * An API the person added themselves.
 *
 * `status` distinguishes "the fields are saved" from "a request worked":
 * `configured` is not a connection, and the UI never shows it as one.
 */
export const customIntegrations = pgTable(
  "custom_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    // 'ai' | 'automation' | 'api' | 'communication' | 'social' | 'other'
    category: text("category").notNull().default("other"),
    baseUrl: text("base_url").notNull(),
    // 'bearer' | 'header' | 'query' | 'basic' | 'none'
    authType: text("auth_type").notNull().default("bearer"),
    credentialCiphertext: text("credential_ciphertext"),
    credentialHint: text("credential_hint"),
    description: text("description"),
    capabilities: jsonb("capabilities")
      .$type<string[]>()
      .notNull()
      .default([]),
    // 'configured' | 'verified' | 'error'
    status: text("status").notNull().default("configured"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("custom_integrations_user_idx").on(table.userId, table.createdAt),
  ]
)

export type CustomIntegration = typeof customIntegrations.$inferSelect
export type NewCustomIntegration = typeof customIntegrations.$inferInsert

/**
 * An MCP endpoint the person added.
 *
 * `transport` is `http` only: this app runs in the cloud and never runs a local
 * command on someone's machine. `tools` holds what the server itself listed, so
 * an empty array means "nothing discovered yet", never "pretend it works".
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    transport: text("transport").notNull().default("http"),
    url: text("url").notNull(),
    // 'none' | 'bearer' | 'header'
    authType: text("auth_type").notNull().default("none"),
    credentialCiphertext: text("credential_ciphertext"),
    credentialHint: text("credential_hint"),
    enabled: boolean("enabled").notNull().default(true),
    tools: jsonb("tools")
      .$type<Array<{ name: string; description?: string }>>()
      .notNull()
      .default([]),
    // 'unverified' | 'connected' | 'error'
    status: text("status").notNull().default("unverified"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("mcp_servers_user_idx").on(table.userId, table.createdAt),
  ]
)

export type McpServer = typeof mcpServers.$inferSelect
export type NewMcpServer = typeof mcpServers.$inferInsert
