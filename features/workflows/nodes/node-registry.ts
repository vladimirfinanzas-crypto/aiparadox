import type { Node } from "@xyflow/react"
import {
  Bot,
  Clock,
  Eye,
  GitBranch,
  Globe,
  Mail,
  MonitorSmartphone,
  MousePointerClick,
  Pointer,
  ScanText,
  Share2,
  Webhook,
  type LucideIcon,
} from "lucide-react"

import {
  nodeCatalog,
  type AutomationNodeType,
  type NodeKind,
} from "@/lib/automations/catalog"

// The canvas' view of a block: the pure catalogue plus the parts that only mean
// something on screen (an icon and a colour). Validation, the engine and the
// model read `lib/automations/catalog`; this file must not become a second
// source of truth for fields or outputs.

export type StepNodeKind = NodeKind
export type NodeType = AutomationNodeType

export type NodeField = {
  key: string
  label: string
  placeholder?: string
  multiline?: boolean
  required?: boolean
}

export type NodeOutput = {
  path: string
  label: string
}

export type NodeDefinition = {
  type: NodeType
  kind: StepNodeKind
  label: string
  icon: LucideIcon
  accent: string
  fields: NodeField[]
  outputs: NodeOutput[]
  /**
   * Which shelf of the palette this block sits on. The canvas owns this purely
   * presentational grouping: validation, the engine and the model keep reading
   * `lib/automations/catalog`, and every node type must appear in exactly one
   * category (pinned by a test).
   */
  category: NodeCategoryId
}

// The palette's shelves, in the order they are shown. Only blocks whose
// execution really exists are here — there is no shelf for a capability the app
// does not implement.
export const nodeCategories = [
  { id: "triggers", label: "Disparadores" },
  { id: "ai", label: "Godfather e IA" },
  { id: "browser", label: "Navegador · Playwright y Browserbase" },
  { id: "desktop", label: "PC local · Desktop Agent" },
  { id: "integrations", label: "APIs e integraciones" },
  { id: "logic", label: "Datos y lógica" },
] as const

export type NodeCategoryId = (typeof nodeCategories)[number]["id"]

const categories: Record<NodeType, NodeCategoryId> = {
  start: "triggers",
  agent: "ai",
  "open-url": "browser",
  act: "browser",
  extract: "browser",
  observe: "browser",
  "desktop-action": "desktop",
  "send-email": "integrations",
  "publish-social": "integrations",
  "http-request": "integrations",
  condition: "logic",
  delay: "logic",
}

const icons: Record<NodeType, LucideIcon> = {
  start: MousePointerClick,
  "open-url": Globe,
  act: Pointer,
  extract: ScanText,
  observe: Eye,
  agent: Bot,
  "send-email": Mail,
  "publish-social": Share2,
  "desktop-action": MonitorSmartphone,
  "http-request": Webhook,
  condition: GitBranch,
  delay: Clock,
}

const accents: Record<NodeType, string> = {
  start: "bg-blue-500 text-white",
  "open-url": "bg-emerald-500 text-white",
  act: "bg-violet-500 text-white",
  extract: "bg-amber-500 text-white",
  observe: "bg-sky-500 text-white",
  agent: "bg-rose-500 text-white",
  "send-email": "bg-teal-500 text-white",
  "publish-social": "bg-fuchsia-500 text-white",
  "desktop-action": "bg-orange-500 text-white",
  "http-request": "bg-cyan-600 text-white",
  condition: "bg-indigo-500 text-white",
  delay: "bg-slate-500 text-white",
}

export const nodeRegistry = Object.fromEntries(
  (Object.keys(nodeCatalog) as NodeType[]).map((type) => {
    const entry = nodeCatalog[type]
    return [
      type,
      {
        type,
        kind: entry.kind,
        label: entry.label,
        icon: icons[type],
        accent: accents[type],
        fields: entry.fields,
        outputs: entry.outputs,
        category: categories[type],
      } satisfies NodeDefinition,
    ]
  })
) as Record<NodeType, NodeDefinition>

export type StepNodeData = {
  type: NodeType
  kind: StepNodeKind
  title: string
  values: Record<string, string>
}

export type StepNodeType = Node<StepNodeData, "step">

export type ActionNodeType = {
  [K in NodeType]: (typeof nodeRegistry)[K]["kind"] extends "action" ? K : never
}[NodeType]
