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
