"use client"

import { useSyncExternalStore } from "react"
import {
  ConnectionLineType,
  Controls,
  Panel,
  ReactFlow,
  type ColorMode,
  type Edge,
  type NodeTypes,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react"

import { useTheme } from "@/components/theme-provider"
import { RunIndicator } from "@/features/workflows/components/run-indicator"
import { StepNode } from "@/features/workflows/components/step-node"
import type { StepNodeType } from "@/features/workflows/nodes/node-registry"

import "@xyflow/react/dist/style.css"

const nodeTypes: NodeTypes = { step: StepNode }

const emptySubscribe = () => () => {}

// False during server render and hydration, true after mount: keeps the server
// and first client render identical, so the canvas never mismatches hydration.
function useMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  )
}

export function Canvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  liveLabel,
}: {
  nodes: StepNodeType[]
  edges: Edge[]
  onNodesChange: OnNodesChange<StepNodeType>
  onEdgesChange: OnEdgesChange
  onConnect: OnConnect
  liveLabel?: string
}) {
  const { resolvedTheme } = useTheme()
  const mounted = useMounted()
  const colorMode: ColorMode = mounted ? ((resolvedTheme as ColorMode) ?? "light") : "light"

  return (
    <div className="size-full">
      <ReactFlow
        nodeTypes={nodeTypes}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        colorMode={colorMode}
        fitView
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionLineStyle={{ stroke: "var(--border)" }}
        defaultEdgeOptions={{
          type: "smoothstep",
          style: { stroke: "var(--border)" },
        }}
        style={
          {
            "--xy-background-color": "var(--background)",
            "--xy-edge-stroke-width": 2,
            "--xy-connectionline-stroke-width": 2,
          } as React.CSSProperties
        }
        maxZoom={1}
      >
        <Controls />
        {liveLabel && (
          <Panel position="top-right">
            <RunIndicator label={liveLabel} />
          </Panel>
        )}
      </ReactFlow>
    </div>
  )
}
