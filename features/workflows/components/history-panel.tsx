"use client"

import { useState, useTransition } from "react"
import { formatDistanceToNowStrict } from "date-fns"
import { ChevronDown, RotateCcw, Square } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cancelRunAction, retryRunAction } from "@/actions/automations"
import { cn } from "@/lib/utils"

// The run history, read from the database. A run that finished last week is
// still here, with each block's outcome and error: this is what makes a failure
// debuggable without the person having kept the tab open.

export type RunStepView = {
  nodeId: string
  title: string
  nodeType: string
  status: "pending" | "running" | "done" | "failed" | "skipped"
  attempt: number
  error: string | null
  durationMs: number | null
}

export type RunView = {
  id: string
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "blocked"
  origin: string
  environment: string
  version: number
  startedAt: string
  durationMs: number | null
  error: string | null
  steps: RunStepView[]
}

const STATUS_LABEL: Record<RunView["status"], string> = {
  queued: "En cola",
  running: "En curso",
  succeeded: "Completada",
  failed: "Fallida",
  cancelled: "Cancelada",
  blocked: "Bloqueada",
}

const STATUS_VARIANT: Record<
  RunView["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  queued: "outline",
  running: "secondary",
  succeeded: "default",
  failed: "destructive",
  cancelled: "outline",
  blocked: "outline",
}

const ORIGIN_LABEL: Record<string, string> = {
  manual: "manual",
  schedule: "programada",
  godfather: "Godfather",
  api: "API",
}

const STEP_DOT: Record<RunStepView["status"], string> = {
  pending: "bg-muted-foreground/40",
  running: "bg-blue-500 animate-pulse",
  done: "bg-emerald-500",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/20",
}

function duration(run: RunView) {
  if (!run.durationMs) return null
  if (run.durationMs < 1000) return `${run.durationMs} ms`
  if (run.durationMs < 60_000) return `${(run.durationMs / 1000).toFixed(1)} s`
  return `${Math.round(run.durationMs / 60_000)} min`
}

export function HistoryPanel({
  runs,
  onChanged,
}: {
  runs: RunView[]
  onChanged: () => void
}) {
  const [openRun, setOpenRun] = useState<string | null>(runs[0]?.id ?? null)
  const [isPending, startTransition] = useTransition()

  if (runs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        Aún no hay ejecuciones. Cuando ejecutes esta automatización, aquí quedará
        cada paso con su resultado.
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-2">
      <ul className="space-y-1.5">
        {runs.map((run) => {
          const expanded = openRun === run.id
          const isLive = run.status === "running" || run.status === "queued"

          return (
            <li key={run.id} className="rounded-lg border border-border/60">
              <button
                type="button"
                onClick={() => setOpenRun(expanded ? null : run.id)}
                className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs hover:bg-muted/40"
              >
                <ChevronDown
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform",
                    expanded && "rotate-180"
                  )}
                />
                {isLive ? (
                  <Spinner className="size-3.5 shrink-0" />
                ) : (
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      STEP_DOT[run.status === "succeeded" ? "done" : run.status === "failed" ? "failed" : "pending"]
                    )}
                  />
                )}
                <span className="font-medium">{STATUS_LABEL[run.status]}</span>
                <span className="text-muted-foreground">
                  {ORIGIN_LABEL[run.origin] ?? run.origin}
                </span>
                <span className="ml-auto flex items-center gap-2 text-muted-foreground">
                  {duration(run) && <span>{duration(run)}</span>}
                  <span>v{run.version}</span>
                  <span>{formatDistanceToNowStrict(new Date(run.startedAt))}</span>
                </span>
              </button>

              {expanded && (
                <div className="space-y-2 border-t border-border/60 p-2.5">
                  {run.error && (
                    <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-[11px] text-destructive">
                      {run.error}
                    </p>
                  )}

                  <ol className="space-y-1">
                    {run.steps.length === 0 && (
                      <li className="text-[11px] text-muted-foreground">
                        Sin pasos registrados todavía.
                      </li>
                    )}
                    {run.steps.map((step) => (
                      <li key={step.nodeId} className="flex items-start gap-2 text-[11px]">
                        <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", STEP_DOT[step.status])} />
                        <div className="min-w-0">
                          <p className="font-medium">
                            {step.title}
                            {step.attempt > 1 && (
                              <span className="ml-1 text-muted-foreground">
                                (intento {step.attempt})
                              </span>
                            )}
                          </p>
                          {step.error && <p className="text-destructive">{step.error}</p>}
                        </div>
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          {step.durationMs != null ? `${step.durationMs} ms` : ""}
                        </span>
                      </li>
                    ))}
                  </ol>

                  <div className="flex gap-1.5 pt-1">
                    {isLive && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-[11px]"
                        disabled={isPending}
                        onClick={() => {
                          startTransition(async () => {
                            const result = await cancelRunAction({ runId: run.id })
                            if (!result.ok) {
                              toast.error(result.errors[0]?.message ?? "No se pudo cancelar.")
                              return
                            }
                            toast.success("Ejecución cancelada")
                            onChanged()
                          })
                        }}
                      >
                        <Square className="size-3" />
                        Detener
                      </Button>
                    )}
                    {(run.status === "failed" || run.status === "cancelled" || run.status === "blocked") && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-[11px]"
                        disabled={isPending}
                        onClick={() => {
                          startTransition(async () => {
                            const result = await retryRunAction({ runId: run.id })
                            if (!result.ok) {
                              toast.error(result.errors[0]?.message ?? "No se pudo reintentar.")
                              return
                            }
                            toast.success("Reintento iniciado")
                            onChanged()
                          })
                        }}
                      >
                        <RotateCcw className="size-3" />
                        Reintentar
                      </Button>
                    )}
                    <Badge variant={STATUS_VARIANT[run.status]} className="ml-auto">
                      {run.environment}
                    </Badge>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
