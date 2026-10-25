import { tasks } from "@trigger.dev/sdk"
import { tool } from "ai"
import { and, desc, eq } from "drizzle-orm"
import { z } from "zod"

import { db } from "@/db"
import { widgets, widgetInsertSchema } from "@/db/schema"
import { executionTargetOf } from "@/lib/automations/catalog"
import { emptyDefinition } from "@/lib/automations/definition"
import { availableEnvNames } from "@/lib/automations/env"
import {
  applyProposal,
  automationSnapshot,
  describeDefinition,
  proposeDefinition,
} from "@/lib/automations/tools"
import { validateDefinition } from "@/lib/automations/validate"
import {
  attachTriggerRun,
  createAutomation,
  createRun,
  listAutomations,
} from "@/queries/automations"
import {
  createDocument,
  mergePanelDocuments,
  normalizeBlocks,
  readPanelDocument,
} from "@/lib/panels/document"
import {
  createWorkspacePanel,
  listWorkspaceVersions,
  saveWorkspacePanel,
} from "@/queries/workspace"
import { getLiveFeed } from "@/queries/live"

// ---------------------------------------------------------------------------
// Workspace tools — the agent's hands on the dashboard itself.
//
// These are what turn "make me a panel for my posts" or "save this process as
// an automation" into real rows: the same tables the Panels and Automations
// sections read. Every call is scoped to the person who owns the conversation;
// an id from another account never resolves.
// ---------------------------------------------------------------------------

// The block catalogue the runtime can draw. The agent describes panels in these
// blocks and the server normalizes, clamps and validates whatever comes back.
const panelBlock = z
  .record(z.string(), z.unknown())
  .describe(
    "Un bloque del panel. Tipos: heading {text, level}, text {text}, stats {title, items:[{label, value, hint}]}, table {title, columns:[string], rows:[[celda]]}, checklist {title, items:[{label, detail, done}]}, list {title, items:[{title, detail, status}]}, calendar {title, events:[{date:'YYYY-MM-DD', title, detail}]}, form {title, fields:[{label, kind:'text'|'textarea'|'date'|'select', options, value}]}, chart {title, series:[{label, value}]}."
  )

const panelBlocks = z.array(panelBlock).min(1).max(24)

const blocksCatalogueError =
  "Ninguno de esos bloques está en el catálogo. Usa heading, text, stats, table, checklist, list, calendar, form o chart."

export function createWorkspaceTools(userId: string) {
  return {
    panel_list: tool({
      description:
        "List the panels this person has, with their id, description, how many blocks they contain and their publication state. Call this before editing one so the id is real.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await db
          .select({
            id: widgets.id,
            name: widgets.name,
            config: widgets.config,
            isPublished: widgets.isPublished,
            updatedAt: widgets.updatedAt,
          })
          .from(widgets)
          .where(eq(widgets.userId, userId))
          .orderBy(widgets.order, desc(widgets.updatedAt))

        return {
          panels: rows.map((row) => {
            const document = readPanelDocument(row.config)
            return {
              id: row.id,
              name: row.name,
              description: document.description ?? null,
              blocks: document.blocks.length,
              isPublished: row.isPublished,
              updatedAt: row.updatedAt.toISOString(),
            }
          }),
        }
      },
    }),

    panel_get: tool({
      description:
        "Read one panel's full document: its description and blocks, with the data the person has already saved. Call this before changing an existing panel, so you keep the blocks they use and their ids.",
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const panel = await db.query.widgets.findFirst({
          where: and(eq(widgets.id, id), eq(widgets.userId, userId)),
          columns: { id: true, name: true, config: true, isPublished: true },
        })
        if (!panel) {
          throw new Error("No panel with that id belongs to this account.")
        }

        return {
          id: panel.id,
          name: panel.name,
          isPublished: panel.isPublished,
          document: readPanelDocument(panel.config),
        }
      },
    }),

    panel_create: tool({
      description:
        "Create a persistent panel: an interface the person opens and uses, not a chat answer. Use this when they ask for a tool, a tracker, a planner or a dashboard. It is created as a draft unless publish is true.",
      inputSchema: z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(400).optional(),
        blocks: panelBlocks,
        publish: z.boolean().optional(),
      }),
      execute: async ({ name, description, blocks, publish }) => {
        const document = createDocument({ description, blocks })
        if (document.blocks.length === 0) throw new Error(blocksCatalogueError)

        const data = widgetInsertSchema.parse({ name, type: "panel" })

        // The same path the Workspace interface uses: the panel is created with
        // its first version frozen, so a later change can be undone.
        const panel = await createWorkspacePanel({
          userId,
          name: data.name,
          document,
          author: "godfather",
        })

        if (publish) {
          await db
            .update(widgets)
            .set({ isPublished: true })
            .where(and(eq(widgets.id, panel.id), eq(widgets.userId, userId)))
        }

        return {
          id: panel.id,
          name: panel.name,
          isPublished: publish ?? false,
          blocks: document.blocks.length,
          path: `/widgets/${panel.id}`,
          note: "Dile a la persona que el panel está listo y dale la ruta para abrirlo.",
        }
      },
    }),

    panel_update: tool({
      description:
        "Change an existing panel. `blocks` replaces the structure; blocks you keep (same id and type) keep the data the person already saved. `appendBlocks` adds sections at the end without touching the rest. Only the fields you pass change.",
      inputSchema: z.object({
        id: z.string().min(1),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(400).optional(),
        blocks: panelBlocks.optional(),
        appendBlocks: z.array(panelBlock).min(1).max(12).optional(),
      }),
      execute: async ({ id, name, description, blocks, appendBlocks }) => {
        const panel = await db.query.widgets.findFirst({
          where: and(eq(widgets.id, id), eq(widgets.userId, userId)),
          columns: { id: true, name: true, config: true, isPublished: true },
        })
        if (!panel) {
          throw new Error("No panel with that id belongs to this account.")
        }
        if (!blocks && !appendBlocks && !name && description === undefined) {
          throw new Error(
            "Nothing to update: pass name, description, blocks or appendBlocks."
          )
        }

        const previous = readPanelDocument(panel.config)
        let document = previous

        if (blocks) {
          const next = createDocument({ description, blocks })
          if (next.blocks.length === 0) throw new Error(blocksCatalogueError)
          document = mergePanelDocuments(previous, next)
        } else if (appendBlocks) {
          const appended = normalizeBlocks(appendBlocks)
          if (appended.length === 0) throw new Error(blocksCatalogueError)

          const taken = new Set(previous.blocks.map((block) => block.id))
          const unique = appended.map((block) => {
            let nextId = block.id
            let suffix = 2
            while (taken.has(nextId)) nextId = `${block.id}-${suffix++}`
            taken.add(nextId)
            return { ...block, id: nextId }
          })

          document = {
            ...previous,
            description: description ?? previous.description,
            blocks: [...previous.blocks, ...unique],
          }
        } else if (description !== undefined) {
          document = { ...previous, description: description || undefined }
        }

        // A layout change becomes a new version; the rows, ticks and values in
        // the blocks that survived are kept by mergePanelDocuments above.
        const saved = await saveWorkspacePanel({
          userId,
          id,
          document,
          author: "godfather",
          summary: "Cambio propuesto por Godfather",
        })

        const updated = name
          ? await db
              .update(widgets)
              .set({ name })
              .where(and(eq(widgets.id, id), eq(widgets.userId, userId)))
              .returning({
                id: widgets.id,
                name: widgets.name,
                isPublished: widgets.isPublished,
              })
          : [{ id: saved.panel.id, name: saved.panel.name, isPublished: saved.panel.isPublished }]

        if (!updated[0]) {
          throw new Error("No panel with that id belongs to this account.")
        }

        return {
          ...updated[0],
          version: saved.version,
          blocks: document.blocks.length,
          path: `/widgets/${saved.panel.id}`,
        }
      },
    }),

    live_tasks: tool({
      description:
        "Read what this person's agents are doing right now: automation runs in progress, flows waiting for their approval, browser/desktop tasks, local jobs queued for the Desktop Agent and recent failures. It is the same data Live View shows. Report it as it is — a task without a reported total has no percentage.",
      inputSchema: z.object({}),
      execute: async () => {
        const feed = await getLiveFeed(userId)
        return {
          counts: feed.counts,
          devices: feed.devices,
          tasks: feed.items.slice(0, 12).map((item) => ({
            id: item.id,
            source: item.source,
            title: item.title,
            status: item.statusLabel,
            ...(item.progress
              ? { progress: `${item.progress.done} de ${item.progress.total} pasos` }
              : {}),
            ...(item.href ? { link: item.href } : {}),
            ...(item.error ? { error: item.error } : {}),
            updatedAt: item.updatedAt,
          })),
        }
      },
    }),

    panel_versions: tool({
      description:
        "List the layout history of one panel, newest first, with what changed in each version. Use it when the person asks what changed or wants to go back to an earlier design.",
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const panel = await db.query.widgets.findFirst({
          where: and(eq(widgets.id, id), eq(widgets.userId, userId)),
          columns: { id: true, name: true, version: true },
        })
        if (!panel) throw new Error("No panel with that id belongs to this account.")

        const versions = await listWorkspaceVersions(userId, id)
        return {
          id: panel.id,
          name: panel.name,
          currentVersion: panel.version,
          versions: versions.map((version) => ({
            version: version.version,
            author: version.author,
            note: version.note,
            blocks: version.blocks,
            summary: version.summary,
            createdAt: version.createdAt.toISOString(),
          })),
        }
      },
    }),

    panel_publish: tool({
      description:
        "Publish or disable a panel. Published panels are visible; disabled ones stay saved as a draft.",
      inputSchema: z.object({
        id: z.string().min(1),
        publish: z.boolean(),
      }),
      execute: async ({ id, publish }) => {
        const [panel] = await db
          .update(widgets)
          .set({ isPublished: publish, updatedAt: new Date() })
          .where(and(eq(widgets.id, id), eq(widgets.userId, userId)))
          .returning({
            id: widgets.id,
            name: widgets.name,
            isPublished: widgets.isPublished,
          })

        if (!panel) {
          throw new Error("No panel with that id belongs to this account.")
        }

        return panel
      },
    }),

    automation_list: tool({
      description:
        "List this person's saved automations with their id, status, block count, next scheduled run and last run. Call this before reading, editing or running one.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await listAutomations(userId)
        return {
          automations: rows.map((row) => ({
            id: row.id,
            name: row.name,
            status: row.status,
            blocks: row.nodeCount,
            trigger: row.triggerKind,
            nextRunAt: row.nextRunAt?.toISOString() ?? null,
            lastRunAt: row.lastRunAt?.toISOString() ?? null,
            updatedAt: row.updatedAt.toISOString(),
          })),
        }
      },
    }),

    automation_get: tool({
      description:
        "Read one automation's current definition, its status and a summary of its trigger, blocks and external effects. Use it before changing anything.",
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const snapshot = await automationSnapshot(userId, id)
        if (!snapshot) throw new Error("No automation with that id belongs to this account.")

        return {
          id: snapshot.id,
          name: snapshot.name,
          status: snapshot.status,
          version: snapshot.version,
          path: `/workflows/${snapshot.id}`,
          summary: snapshot.summary,
          definition: snapshot.definition,
        }
      },
    }),

    automation_create: tool({
      description:
        "Save a new, empty automation for this person. Prefer automation_update_definition when you already know what the flow should do: create it and then describe it in the same turn. It is saved as a draft and is never activated here.",
      inputSchema: z.object({
        name: z.string().min(1).max(100),
      }),
      execute: async ({ name }) => {
        const definition = emptyDefinition(name)
        const automation = await createAutomation({ userId, name, definition })

        return {
          id: automation.id,
          name: automation.name,
          status: automation.status,
          blocks: 0,
          path: `/workflows/${automation.id}`,
        }
      },
    }),

    automation_update_definition: tool({
      description:
        "Build or change an automation from a plain-language instruction. Say what the flow must achieve (blocks, order, schedule, recipient); the server validates the result and saves it as a new draft version. Never claim it will run on its own: activation needs the person's explicit approval.",
      inputSchema: z.object({
        id: z.string().min(1),
        instruction: z
          .string()
          .min(3)
          .max(2_000)
          .describe(
            "What the automation must do, including any concrete values (recipient, URL, networks) the person gave you. Do not invent values they did not give."
          ),
      }),
      execute: async ({ id, instruction }) => {
        const snapshot = await automationSnapshot(userId, id)
        if (!snapshot) throw new Error("No automation with that id belongs to this account.")

        const proposal = await proposeDefinition({
          instruction,
          current: snapshot.definition,
          timezone: snapshot.definition.trigger.timezone,
        })

        if (!proposal.ok || !proposal.definition) {
          return {
            saved: false,
            message: proposal.message,
            problems: proposal.issues.map((issue) => issue.message),
          }
        }

        const report = validateDefinition(proposal.definition, {
          availableEnv: availableEnvNames(),
        })
        if (!report.ok) {
          return {
            saved: false,
            message: proposal.message,
            problems: report.errors.map((issue) => issue.message),
          }
        }

        const saved = await applyProposal({ userId, id, definition: proposal.definition })

        return {
          saved: true,
          message: proposal.message,
          status: saved.status,
          version: saved.version,
          path: `/workflows/${id}`,
          flow: describeDefinition(proposal.definition),
          effects: report.effects,
          warnings: report.warnings.map((issue) => issue.message),
        }
      },
    }),

    automation_validate: tool({
      description:
        "Check a saved automation for structural problems and missing credentials without changing it. Returns the errors a person would need to fix first.",
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const snapshot = await automationSnapshot(userId, id)
        if (!snapshot) throw new Error("No automation with that id belongs to this account.")

        const report = validateDefinition(snapshot.definition, {
          availableEnv: availableEnvNames(),
        })

        return {
          valid: report.ok,
          errors: report.errors.map((issue) => issue.message),
          warnings: report.warnings.map((issue) => issue.message),
          effects: report.effects,
        }
      },
    }),

    automation_run: tool({
      description:
        "Run a saved automation now, in the background. It must be connected and valid; the run writes its own history the person can open later.",
      inputSchema: z.object({
        id: z.string().min(1),
      }),
      execute: async ({ id }) => {
        const snapshot = await automationSnapshot(userId, id)
        if (!snapshot) throw new Error("No automation with that id belongs to this account.")

        const report = validateDefinition(snapshot.definition, {
          availableEnv: availableEnvNames(),
        })
        if (!report.ok) {
          throw new Error(
            `${snapshot.name} no se puede ejecutar todavía: ${report.errors[0]?.message ?? "el flujo no es válido"}`
          )
        }

        const run = await createRun({
          userId,
          workflowId: snapshot.id,
          version: snapshot.version,
          origin: "godfather",
          environment: executionTargetOf(snapshot.definition.nodes),
          idempotencyKey: `godfather:${snapshot.id}:${Date.now()}`,
        })

        const handle = await tasks.trigger("run-automation", { runId: run.id })
        await attachTriggerRun(run.id, handle.id)

        return {
          runId: run.id,
          name: snapshot.name,
          path: `/workflows/${snapshot.id}`,
        }
      },
    }),
  }
}

export type WorkspaceTools = ReturnType<typeof createWorkspaceTools>
