import type { Edge } from "@xyflow/react"
import { z } from "zod"

import type { WorkflowGraph } from "@/db/schema"
import {
  catalogFor,
  executionTargetOf,
  nodeTypes,
  type AutomationExecutionTarget,
  type AutomationNodeType,
  type NodeKind,
} from "@/lib/automations/catalog"

// The structured flow both interfaces work on.
//
// The visual editor and Godfather do not have their own formats: the canvas is a
// projection of this object and the model writes this object. That is what makes
// "edit it in the canvas, then ask Godfather for a change" one document with one
// version counter instead of two systems that drift.

export const AUTOMATION_SCHEMA_VERSION = 2

export const nodeTypeSchema = z.enum(nodeTypes)

export const automationNodeSchema = z.object({
  id: z.string().min(1).max(64),
  type: nodeTypeSchema,
  kind: z.enum(["trigger", "action", "condition"]),
  title: z.string().trim().min(1).max(80),
  config: z.record(z.string(), z.string()).default({}),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
})

export const automationEdgeSchema = z.object({
  id: z.string().min(1).max(64),
  source: z.string().min(1).max(64),
  target: z.string().min(1).max(64),
  // Which side of a condition this edge leaves from. Absent on plain edges.
  sourceHandle: z.enum(["true", "false"]).optional(),
})

export const automationTriggerSchema = z.object({
  kind: z.enum(["manual", "cron", "once"]),
  // Five-field cron, required when kind is "cron".
  cron: z.string().max(120).optional(),
  // ISO timestamp, required when kind is "once".
  runAt: z.string().max(64).optional(),
  // IANA zone. The person's local time is what the schedule means.
  timezone: z.string().default("UTC"),
})

export const automationSettingsSchema = z.object({
  onError: z.enum(["stop", "continue"]).default("stop"),
  // Retries per step, not per run: a retried run would repeat side effects.
  retries: z.number().int().min(0).max(3).default(0),
  maxSteps: z.number().int().min(1).max(80).default(40),
  timeoutMs: z.number().int().min(5_000).max(3_600_000).default(900_000),
})

export const automationDefinitionSchema = z.object({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(400).optional(),
  trigger: automationTriggerSchema,
  nodes: z.array(automationNodeSchema).max(40),
  edges: z.array(automationEdgeSchema).max(80),
  settings: automationSettingsSchema,
})

export type AutomationNode = z.infer<typeof automationNodeSchema>
export type AutomationEdge = z.infer<typeof automationEdgeSchema>
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>
export type AutomationSettings = z.infer<typeof automationSettingsSchema>
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>

export const DEFAULT_SETTINGS: AutomationSettings = {
  onError: "stop",
  retries: 0,
  maxSteps: 40,
  timeoutMs: 900_000,
}

export function emptyDefinition(
  name: string,
  timezone = "UTC"
): AutomationDefinition {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    name,
    trigger: { kind: "manual", timezone },
    nodes: [
      {
        id: "start",
        type: "start",
        kind: "trigger",
        title: "Start",
        config: {},
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    settings: { ...DEFAULT_SETTINGS },
  }
}

/** A definition built from a flow the person already has in the database. */
export function definitionFromGraph({
  name,
  graph,
  timezone = "UTC",
  description,
}: {
  name: string
  graph: WorkflowGraph | null | undefined
  timezone?: string
  description?: string
}): AutomationDefinition {
  const base = emptyDefinition(name, timezone)
  if (!graph || graph.nodes.length === 0) {
    return { ...base, ...(description ? { description } : {}) }
  }

  const nodes: AutomationNode[] = graph.nodes.map((node) => ({
    id: node.id,
    type: node.data.type,
    kind: node.data.kind,
    title: node.data.title,
    config: { ...node.data.values },
    position: { x: node.position.x, y: node.position.y },
  }))

  const edges: AutomationEdge[] = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle === "true" || edge.sourceHandle === "false"
      ? { sourceHandle: edge.sourceHandle }
      : {}),
  }))

  return {
    ...base,
    ...(description ? { description } : {}),
    nodes,
    edges,
  }
}

/** The React Flow projection of a definition. The canvas never edits anything
 *  else, so what is on screen and what the server runs are the same document. */
export function definitionToGraph(definition: AutomationDefinition): WorkflowGraph {
  const nodes = definition.nodes.map((node) => ({
    id: node.id,
    type: "step" as const,
    position: node.position,
    data: {
      type: node.type,
      kind: node.kind,
      title: node.title,
      values: node.config,
    },
  }))

  const edges: Edge[] = definition.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
  }))

  return { nodes, edges }
}

/** Read back what the canvas holds. Positions, titles and configs come from the
 *  live graph; everything else (trigger, settings, name) is preserved. */
export function definitionFromCanvas({
  base,
  graph,
}: {
  base: AutomationDefinition
  graph: WorkflowGraph
}): AutomationDefinition {
  return {
    ...base,
    nodes: graph.nodes.map((node) => {
      const catalog = catalogFor(node.data.type)
      return {
        id: node.id,
        type: node.data.type,
        kind: catalog?.kind ?? node.data.kind,
        title: node.data.title,
        config: { ...node.data.values },
        position: { x: node.position.x, y: node.position.y },
      }
    }),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle === "true" || edge.sourceHandle === "false"
        ? { sourceHandle: edge.sourceHandle }
        : {}),
    })),
  }
}

/** A canonical string for a definition, for comparisons only.
 *  Postgres' jsonb reorders object keys, so a plain JSON.stringify of a value
 *  read back from the database never equals the one that was written, even
 *  when the two are the same document. Sorting keys on both sides fixes that. */
export function definitionKey(definition: AutomationDefinition): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, stable(item)])
      )
    }
    return value
  }

  return JSON.stringify(stable(definition))
}

export type ParseResult =
  | { ok: true; definition: AutomationDefinition }
  | { ok: false; issues: string[] }

/** Parse whatever arrived from a client, a database row or the model. */
export function parseDefinition(input: unknown): ParseResult {
  const parsed = automationDefinitionSchema.safeParse(input)
  if (parsed.success) return { ok: true, definition: parsed.data }

  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => {
      const path = issue.path.join(".")
      return path ? `${path}: ${issue.message}` : issue.message
    }),
  }
}

/** Where the flow runs, derived from its blocks. Stored on the automation so
 *  the list and the approval screen do not have to re-read the definition. */
export function executionTargetOfDefinition(
  definition: AutomationDefinition
): AutomationExecutionTarget {
  return executionTargetOf(definition.nodes)
}

/** The node types a person may add from the palette. */
export function addableNodeTypes(): AutomationNodeType[] {
  return nodeTypes.filter((type) => type !== "start")
}

export function nodeKindOf(type: AutomationNodeType): NodeKind {
  return catalogFor(type)?.kind ?? "action"
}
