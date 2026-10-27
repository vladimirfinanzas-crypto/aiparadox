"use client"

import { useEffect, useState, useTransition } from "react"
import { format } from "date-fns"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  ArrowRightIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  HistoryIcon,
  RotateCcwIcon,
} from "lucide-react"
import { toast } from "sonner"

import { runAutomationAction } from "@/actions/automations"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

// The run history drawer at the top of Automations: every run across every
// automation the person owns, newest first — each row says which automation it
// was, what happened and for how long, and can be opened or re-run. The rows
// come from the server (scoped to the caller), never from a client cache.

export type GlobalRunRow = {
  id: string
  workflowId: string
  automationName: string
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "blocked"
  origin: string
  version: number
  startedAt: string
  durationMs: number | null
  error: string | null
  steps: Array<{
    nodeId: string
    title: string
    status: "pending" | "running" | "done" | "failed" | "skipped"
    error: string | null
    durationMs: number | null
  }>
}

const STATUS_LABEL: Record<GlobalRunRow["status"], string> = {
  queued: "En cola",
  running: "En curso",
  succeeded: "Completada",
  failed: "Fallida",
  cancelled: "Cancelada",
  blocked: "Bloqueada",
}

const STATUS_VARIANT: Record<
  GlobalRunRow["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  queued: "outline",
  running: "secondary",
  succeeded: "default",
  failed: "destructive",
  cancelled: "outline",
  blocked: "outline",
}

function duration(ms: number | null): string | null {
  if (!ms) return null
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms / 60_000)} min`
}

/** One line about what actually happened, from the recorded steps. */
function summarize(run: GlobalRunRow): string {
  const failed = run.steps.find((step) => step.status === "failed")
  if (failed) return `Se detuvo en «${failed.title}»`

  const done = run.steps.filter((step) => step.status === "done").length
  if (run.status === "succeeded") {
    return run.steps.length > 0 ? `${done}/${run.steps.length} bloques completados` : "Sin pasos"
  }
  if (run.status === "cancelled") return "Detenida por ti"
  if (run.status === "running" || run.status === "queued") return "En curso…"
  if (run.error) return run.error
  return run.version ? `v${run.version}` : "—"
}

export function HistoryToggle({ runs }: { runs: GlobalRunRow[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [pendingRunId, setPendingRunId] = useState<string | null>(null)

  const hasLiveRun = runs.some(
    (run) => run.status === "running" || run.status === "queued"
  )

  // While the drawer is open and something is actually running, the list keeps
  // itself current; when nothing runs, no polling at all.
  useEffect(() => {
    if (!open || !hasLiveRun) return
    const timer = setInterval(() => router.refresh(), 4_000)
    return () => clearInterval(timer)
  }, [open, hasLiveRun, router])

  const rerun = (run: GlobalRunRow) => {
    setPendingRunId(run.id)
    startTransition(async () => {
      try {
        const result = await runAutomationAction({ id: run.workflowId })
        if (!result.ok) {
          toast.error(result.errors[0]?.message ?? "No se pudo reejecutar.")
          return
        }
        toast.success(`Ejecutando «${run.automationName}»`)
        router.refresh()
      } catch {
        toast.error("No se pudo reejecutar: la automatización ya no existe.")
      } finally {
        setPendingRunId(null)
      }
    })
  }

  const liveByAutomation = new Set(
    runs
      .filter((run) => run.status === "running" || run.status === "queued")
      .map((run) => run.workflowId)
  )

  return (
    <div className="mb-6 rounded-2xl border border-border/40 bg-card/50 backdrop-blur-xl">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <HistoryIcon className="size-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">Historial</span>
        <Badge variant="outline">{runs.length}</Badge>
        {hasLiveRun && (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            Hay una ejecución en curso
          </span>
        )}
        <ChevronDownIcon
          className={cn(
            "ml-auto size-4 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
          aria-hidden
        />
      </button>

      {open && (
        <div className="border-t border-border/40 p-2">
          {runs.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              Todavía no hay ejecuciones. Cuando ejecutes una automatización, aquí
              quedará cada una con su resultado.
            </p>
          ) : (
            <ul className="max-h-96 space-y-1.5 overflow-y-auto">
              {runs.map((run) => {
                const busy =
                  liveByAutomation.has(run.workflowId) || pendingRunId === run.id
                const failed = run.steps.find((step) => step.status === "failed")

                return (
                  <li
                    key={run.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border/60 px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/workflows/${run.workflowId}`}
                          className="truncate text-sm font-medium hover:underline"
                        >
                          {run.automationName}
                        </Link>
                        <Badge variant={STATUS_VARIANT[run.status]}>
                          {STATUS_LABEL[run.status]}
                        </Badge>
                        <span className="text-[11px] text-muted-foreground">
                          v{run.version}
                        </span>
                      </div>

                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span>{format(new Date(run.startedAt), "d MMM yyyy, HH:mm")}</span>
                        {run.durationMs !== null && <span>· {duration(run.durationMs)}</span>}
                        <span className="truncate">· {summarize(run)}</span>
                      </p>

                      {failed?.error && (
                        <p className="mt-1 flex items-start gap-1.5 text-xs text-destructive">
                          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                          <span className="line-clamp-2">{failed.error}</span>
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-xs"
                        disabled={busy || isPending}
                        onClick={() => rerun(run)}
                      >
                        {pendingRunId === run.id ? (
                          <Spinner className="size-3" />
                        ) : (
                          <RotateCcwIcon className="size-3" aria-hidden />
                        )}
                        Reejecutar
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 text-xs"
                        render={
                          <Link href={`/workflows/${run.workflowId}`} />
                        }
                      >
                        Detalles
                        <ArrowRightIcon className="size-3" aria-hidden />
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
