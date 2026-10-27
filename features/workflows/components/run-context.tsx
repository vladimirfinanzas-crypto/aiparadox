"use client"

import { createContext, useContext } from "react"

// What the canvas needs to paint a block as running, done or failed. It comes
// from the database (a run row and its steps), not from a live subscription, so
// the colours are right after a reload too.

export type RunStepState = {
  nodeId: string
  status: "pending" | "running" | "done" | "failed" | "skipped"
}

type RunContextValue = {
  steps: RunStepState[]
  live: boolean
}

const RunContext = createContext<RunContextValue>({ steps: [], live: false })

export function RunStepsProvider({
  steps,
  live,
  children,
}: RunContextValue & { children: React.ReactNode }) {
  return <RunContext.Provider value={{ steps, live }}>{children}</RunContext.Provider>
}

export function useRunSteps(): RunContextValue {
  return useContext(RunContext)
}

// The validator's verdict, keyed by node: the first blocking error for each
// block. The banner at the top lists them in order; the canvas paints them on
// the block itself so the person can see *which* one is wrong.

const IssuesContext = createContext<Record<string, string>>({})

export function NodeIssuesProvider({
  issues,
  children,
}: {
  issues: Record<string, string>
  children: React.ReactNode
}) {
  return <IssuesContext.Provider value={issues}>{children}</IssuesContext.Provider>
}

export function useNodeIssues(): Record<string, string> {
  return useContext(IssuesContext)
}
