"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { Edge } from "@xyflow/react"

import type { StepNodeType } from "@/features/workflows/nodes/node-registry"

// Undo/redo for the canvas, snapshot based: every committed state of the graph
// can be stepped back to and forward again. Rapid bursts (typing into a field,
// dragging a node) coalesce into one step, and the same autosave that persists
// every other edit persists the reverted state — there is still one truth.

export type GraphSnapshot = {
  nodes: StepNodeType[]
  edges: Edge[]
}

/** How many steps back the person can walk. */
const LIMIT = 50
/** Changes closer together than this belong to the same human gesture. */
const COALESCE_MS = 700

export function useGraphHistory({
  nodes,
  edges,
  setNodes,
  setEdges,
}: {
  nodes: StepNodeType[]
  edges: Edge[]
  setNodes: (nodes: StepNodeType[]) => void
  setEdges: (edges: Edge[]) => void
}) {
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const graphRef = useRef<GraphSnapshot>({ nodes, edges })
  const pastRef = useRef<GraphSnapshot[]>([])
  const futureRef = useRef<GraphSnapshot[]>([])
  const lastPush = useRef(0)
  // Set right before a programmatic replace (undo itself, redo, a server-confirmed
  // definition), so it is not recorded as a change the person made.
  const suppress = useRef(false)

  useEffect(() => {
    if (graphRef.current.nodes === nodes && graphRef.current.edges === edges) return

    const previous = graphRef.current
    graphRef.current = { nodes, edges }

    if (suppress.current) {
      suppress.current = false
      return
    }

    const now = Date.now()
    if (now - lastPush.current < COALESCE_MS) return
    lastPush.current = now

    pastRef.current = [...pastRef.current, previous].slice(-LIMIT)
    futureRef.current = []
    setCanUndo(true)
    setCanRedo(false)
  }, [nodes, edges])

  /** Call immediately before replacing the graph from a confirmed source. */
  const markExternal = useCallback(() => {
    suppress.current = true
  }, [])

  const undo = useCallback(() => {
    const target = pastRef.current.at(-1)
    if (!target) return false

    futureRef.current = [graphRef.current, ...futureRef.current].slice(-LIMIT)
    pastRef.current = pastRef.current.slice(0, -1)
    suppress.current = true
    lastPush.current = 0
    graphRef.current = target
    setNodes(target.nodes)
    setEdges(target.edges)
    setCanUndo(pastRef.current.length > 0)
    setCanRedo(true)
    return true
  }, [setNodes, setEdges])

  const redo = useCallback(() => {
    const target = futureRef.current.at(-1)
    if (!target) return false

    pastRef.current = [...pastRef.current, graphRef.current].slice(-LIMIT)
    futureRef.current = futureRef.current.slice(0, -1)
    suppress.current = true
    lastPush.current = 0
    graphRef.current = target
    setNodes(target.nodes)
    setEdges(target.edges)
    setCanUndo(true)
    setCanRedo(futureRef.current.length > 0)
    return true
  }, [setNodes, setEdges])

  return {
    canUndo,
    canRedo,
    undo,
    redo,
    markExternal,
  }
}
