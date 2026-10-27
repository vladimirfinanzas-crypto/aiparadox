"use client"

import { useState } from "react"
import { useReactFlow, useStore } from "@xyflow/react"
import { Copy, Sparkles, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import type { AutomationDefinition } from "@/lib/automations/definition"
import { GodfatherPanel } from "@/features/workflows/components/godfather-panel"
import { NodeIcon } from "@/features/workflows/components/node-icon"
import { useUpstreamConnections } from "@/features/workflows/hooks/use-upstream-connections"
import {
  nodeCategories,
  nodeRegistry,
  type NodeDefinition,
  type NodeField,
  type NodeType,
  type StepNodeType,
} from "@/features/workflows/nodes/node-registry"

// The right side of the editor: what you can add, what a block is configured
// with, and Godfather working on this same flow. All three edit the same React
// Flow store, so whatever one changes the others see immediately.

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-y border-border bg-card px-3 py-1.5 text-sm font-semibold">
        {icon}
        {title}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}

function Field({
  field,
  value,
  onChange,
  onFocus,
}: {
  field: NodeField
  value: string
  onChange: (value: string) => void
  onFocus: () => void
}) {
  if (field.multiline) {
    return (
      <Textarea
        id={field.key}
        value={value}
        placeholder={field.placeholder}
        onFocus={onFocus}
        onChange={(event) => onChange(event.target.value)}
      />
    )
  }

  return (
    <Input
      id={field.key}
      value={value}
      placeholder={field.placeholder}
      onFocus={onFocus}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

function Inspector({ node }: { node: StepNodeType | undefined }) {
  const { updateNodeData, deleteElements, addNodes, getNodes } = useReactFlow<StepNodeType>()
  const connections = useUpstreamConnections()
  const [activeFieldKey, setActiveFieldKey] = useState<string | null>(null)

  if (!node) {
    return (
      <Section title="Editor">
        <p className="p-3 text-sm text-muted-foreground">
          Selecciona un bloque en el lienzo para configurarlo.
        </p>
      </Section>
    )
  }

  const { type, title, values } = node.data
  const def: NodeDefinition = nodeRegistry[type]
  const targetKey = activeFieldKey ?? def.fields[0]?.key

  const insertToken = (token: string) => {
    if (!targetKey) return
    updateNodeData(node.id, {
      values: { ...values, [targetKey]: (values[targetKey] ?? "") + token },
    })
  }

  return (
    <Section title={title} icon={<NodeIcon type={type} />}>
      <div className="flex flex-col gap-3 p-3">
        {def.fields.length === 0 ? (
          <p className="text-xs text-muted-foreground">Este bloque no tiene ajustes.</p>
        ) : (
          def.fields.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <Label htmlFor={field.key} className="text-xs">
                {field.label}
                {field.required && <span className="text-destructive"> *</span>}
              </Label>
              <Field
                field={field}
                value={values[field.key] ?? ""}
                onFocus={() => setActiveFieldKey(field.key)}
                onChange={(value) => {
                  updateNodeData(node.id, {
                    values: { ...values, [field.key]: value },
                  })
                }}
              />
            </div>
          ))
        )}

        {type === "condition" && (
          <p className="rounded-md border border-border/60 bg-muted/40 p-2 text-[11px] text-muted-foreground">
            Conecta la salida verde a lo que ocurre cuando se cumple, y la roja a lo
            contrario. Solo se ejecuta una de las dos ramas.
          </p>
        )}

        {connections.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Datos de bloques anteriores</Label>
            <div className="flex flex-wrap gap-1.5">
              {connections.map((connection) => (
                <button
                  key={connection.token}
                  type="button"
                  onClick={() => insertToken(connection.token)}
                  className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-1.5 py-1 text-xs hover:bg-accent"
                >
                  <NodeIcon type={connection.nodeType} className="size-4" />
                  <span className="truncate">{connection.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {node.data.type !== "start" && (
          <div className="mt-2 flex flex-col gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="justify-start gap-2.5"
              onClick={() => {
                const nodes = getNodes()
                const count = nodes.filter(
                  (candidate) => candidate.data.type === node.data.type
                ).length
                // A copy keeps the configuration but not the wiring: a
                // duplicated block must be connected on purpose, never inherit
                // an edge the person did not draw.
                addNodes({
                  id: crypto.randomUUID(),
                  type: "step",
                  position: { x: node.position.x + 48, y: node.position.y + 48 },
                  data: {
                    type: node.data.type,
                    kind: node.data.kind,
                    title: `${def.label} ${count + 1}`,
                    values: { ...node.data.values },
                  },
                })
                toast.success("Bloque duplicado")
              }}
            >
              <Copy className="size-3.5" />
              Duplicar bloque
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="justify-start text-destructive"
              onClick={() => {
                deleteElements({ nodes: [{ id: node.id }] })
                toast.success("Bloque eliminado")
              }}
            >
              <Trash2 className="size-3.5" />
              Eliminar bloque
            </Button>
          </div>
        )}
      </div>
    </Section>
  )
}

const definitions = Object.values(nodeRegistry)

function Palette() {
  const { getNodes, getViewport, addNodes } = useReactFlow<StepNodeType>()
  const width = useStore((state) => state.width)
  const height = useStore((state) => state.height)

  const add = (type: NodeType) => {
    const def = nodeRegistry[type]
    const nodes = getNodes()

    if (def.kind === "trigger" && nodes.some((node) => node.data.kind === "trigger")) {
      toast.error("Un flujo solo puede tener un disparador.")
      return
    }

    const count = nodes.filter((node) => node.data.type === type).length
    const { x, y, zoom } = getViewport()
    const position = { x: (width / 2 - x) / zoom, y: (height / 2 - y) / zoom }

    addNodes({
      id: crypto.randomUUID(),
      type: "step",
      position,
      data: {
        type,
        kind: def.kind,
        title: `${def.label} ${count + 1}`,
        values: {},
      },
    })
  }

  return (
    <Section title="Bloques">
      <Accordion
        multiple
        defaultValue={nodeCategories.map((category) => category.id)}
        className="px-3 py-2"
      >
        {nodeCategories.map((category) => {
          const items = definitions.filter((def) => def.category === category.id)
          if (items.length === 0) return null
          return (
            <AccordionItem
              key={category.id}
              value={category.id}
              className="not-last:border-b-0"
            >
              <AccordionTrigger className="py-2 text-xs font-medium text-muted-foreground hover:no-underline">
                {category.label}
              </AccordionTrigger>
              <AccordionContent className="flex flex-col gap-0.5">
                {items.map((def) => (
                  <Button
                    key={def.type}
                    variant="ghost"
                    onClick={() => add(def.type as NodeType)}
                    className="justify-start gap-2.5 px-1.5 text-xs"
                  >
                    <NodeIcon type={def.type as NodeType} />
                    {def.label}
                  </Button>
                ))}
              </AccordionContent>
            </AccordionItem>
          )
        })}
      </Accordion>
    </Section>
  )
}

export function RightSidebar({
  automationId,
  version,
  onApplyDefinition,
}: {
  automationId: string
  version: number
  onApplyDefinition: (definition: AutomationDefinition) => void
}) {
  const [tab, setTab] = useState("blocks")
  const selected = useStore(
    (state) => state.nodes.find((node) => node.selected) as StepNodeType | undefined
  )

  const [previousSelectedId, setPreviousSelectedId] = useState(selected?.id)
  if (selected && selected.id !== previousSelectedId) {
    setPreviousSelectedId(selected.id)
    setTab("editor")
  }

  return (
    <div className="flex w-80 min-w-72 max-w-96 shrink-0 flex-col border-l border-border bg-background">
      <Tabs value={tab} onValueChange={setTab} className="size-full gap-0">
        <TabsList className="m-2 w-fit bg-background">
          <TabsTrigger value="blocks" className="text-xs">
            Bloques
          </TabsTrigger>
          <TabsTrigger value="editor" className="text-xs">
            Editor
          </TabsTrigger>
          <TabsTrigger value="godfather" className="gap-1 text-xs">
            <Sparkles className="size-3" />
            Godfather
          </TabsTrigger>
        </TabsList>
        <TabsContent value="blocks" className="flex min-h-0 flex-col">
          <Palette />
        </TabsContent>
        <TabsContent value="editor" className="flex min-h-0 flex-col">
          <Inspector key={selected?.id} node={selected} />
        </TabsContent>
        <TabsContent value="godfather" className="flex min-h-0 flex-col">
          <GodfatherPanel
            automationId={automationId}
            version={version}
            onApply={onApplyDefinition}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
