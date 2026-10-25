"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import {
  addEdge,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
} from "@xyflow/react"
import { useRouter } from "next/navigation"
import {
  CalendarClock,
  CircleAlert,
  Play,
  Save,
  ShieldCheck,
  Square,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  applyGodfatherProposalAction,
  cancelRunAction,
  deactivateAutomationAction,
  deleteAutomationAction,
  pauseAutomationAction,
  resumeAutomationAction,
  runAutomationAction,
  saveAutomationAction,
} from "@/actions/automations"
import {
  ApprovalDialog,
  ScheduleDialog,
} from "@/features/workflows/components/automation-dialogs"
import { Canvas } from "@/features/workflows/components/canvas"
import { HistoryPanel, type RunView } from "@/features/workflows/components/history-panel"
import { RightSidebar } from "@/features/workflows/components/right-sidebar"
import { RunStepsProvider } from "@/features/workflows/components/run-context"
import {
  definitionFromCanvas,
  definitionKey,
  definitionToGraph,
  type AutomationDefinition,
  type AutomationTrigger,
} from "@/lib/automations/definition"
import {
  validateDefinition,
  type ValidationIssue,
} from "@/lib/automations/validate"
import type { StepNodeType } from "@/features/workflows/nodes/node-registry"

// The editor owns one document: the definition. The canvas is a projection of
// it, the sidebar edits it, Godfather proposes changes to it, and every change
// is saved to Postgres — there is no second copy in a collaboration room.

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  pending_approval: "Pendiente de autorización",
  active: "Activa",
  paused: "Pausada",
  error: "Error",
}

const AUTOSAVE_MS = 1_400

export function Editor({
  automationId,
  initialDefinition,
  initialStatus,
  initialVersion,
  runs,
}: {
  automationId: string
  initialDefinition: AutomationDefinition
  initialStatus: string
  initialVersion: number
  runs: RunView[]
}) {
  const router = useRouter()

  const initialGraph = useMemo(() => definitionToGraph(initialDefinition), [initialDefinition])
  const [base, setBase] = useState<AutomationDefinition>(initialDefinition)
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNodeType>(initialGraph.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialGraph.edges)

  const [name, setName] = useState(initialDefinition.name)
  const [status, setStatus] = useState(initialStatus)
  const [version, setVersion] = useState(initialVersion)
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("saved")
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const [approvalOpen, setApprovalOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)

  const [isRunning, startRun] = useTransition()
  const [isActing, startAction] = useTransition()

  // The last definition the server confirmed, canonicalised. Comparing against
  // state (not a ref) keeps `dirty` honest across re-renders.
  const [savedJson, setSavedJson] = useState(definitionKey(initialDefinition))

  const definition = useMemo(
    () => definitionFromCanvas({ base: { ...base, name }, graph: { nodes, edges } }),
    [base, name, nodes, edges]
  )

  const report = useMemo(() => validateDefinition(definition), [definition])
  const dirty = definitionKey(definition) !== savedJson

  const applyServerDefinition = useCallback(
    (next: AutomationDefinition, nextVersion: number, nextStatus: string) => {
      const graph = definitionToGraph(next)
      setBase(next)
      setName(next.name)
      setNodes(graph.nodes)
      setEdges(graph.edges)
      setVersion(nextVersion)
      setStatus(nextStatus)
      setSavedJson(definitionKey(next))
      setSaveState("saved")
      setSavedAt(Date.now())
    },
    [setEdges, setNodes]
  )

  const save = useCallback(
    async (definitionToSave: AutomationDefinition, { silent }: { silent: boolean }) => {
      setSaveState("saving")
      const result = await saveAutomationAction({ id: automationId, definition: definitionToSave })

      if (!result.ok) {
        setSaveState("error")
        if (!silent) {
          toast.error(
            result.errors[0]?.message ?? "No se pudo guardar la automatización."
          )
        }
        return false
      }

      setSavedJson(definitionKey(definitionToSave))
      setVersion(result.version)
      setStatus(result.status)
      setSaveState("saved")
      setSavedAt(Date.now())

      if (!silent && result.status === "pending_approval") {
        toast.message("Guardado. Cambió lo que hace el flujo, así que necesita tu autorización otra vez.")
      }
      return true
    },
    [automationId]
  )

  // Autosave. It never fires while the flow has errors: saving half a flow would
  // silently destroy a working version, and the person needs to see the problem
  // before that happens.
  useEffect(() => {
    if (!dirty || report.errors.length > 0) return

    const timer = setTimeout(() => {
      void save(definition, { silent: true }).then((ok) => {
        if (ok) router.refresh()
      })
    }, AUTOSAVE_MS)

    return () => clearTimeout(timer)
  }, [definition, dirty, report.errors.length, save, router])

  // While a run is in flight, the page refreshes itself so the canvas and the
  // history move without the person reloading. The moment it ends, polling stops.
  const hasLiveRun = runs.some((run) => run.status === "running" || run.status === "queued")
  useEffect(() => {
    if (!hasLiveRun) return
    const timer = setInterval(() => router.refresh(), 4_000)
    return () => clearInterval(timer)
  }, [hasLiveRun, router])

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: crypto.randomUUID(),
            type: "smoothstep",
            style: { stroke: "var(--border)" },
          },
          current
        )
      )
    },
    [setEdges]
  )

  const liveRun = runs.find((run) => run.status === "running" || run.status === "queued")
  const latest = runs[0]
  const stepStates = (latest?.steps ?? []).map((step) => ({
    nodeId: step.nodeId,
    status: step.status,
  }))

  const run = () => {
    startRun(async () => {
      const result = await runAutomationAction({ id: automationId, definition })
      if (!result.ok) {
        toast.error(result.errors[0]?.message ?? "No se pudo ejecutar.")
        return
      }
      toast.success("Ejecución iniciada")
      router.refresh()
    })
  }

  const stop = () => {
    if (!liveRun) return
    startAction(async () => {
      const result = await cancelRunAction({ runId: liveRun.id })
      if (!result.ok) {
        toast.error(result.errors[0]?.message ?? "No se pudo detener.")
        return
      }
      toast.success("Ejecución cancelada")
      router.refresh()
    })
  }

  const togglePause = () => {
    startAction(async () => {
      const result =
        status === "paused"
          ? await resumeAutomationAction({ id: automationId })
          : await pauseAutomationAction({ id: automationId })

      if (!result.ok) {
        toast.error(result.errors[0]?.message ?? "No se pudo cambiar el estado.")
        return
      }
      setStatus(status === "paused" ? "active" : "paused")
      toast.success(status === "paused" ? "Automatización reanudada" : "Automatización pausada")
      router.refresh()
    })
  }

  const deactivate = () => {
    startAction(async () => {
      const result = await deactivateAutomationAction({ id: automationId })
      if (!result.ok) {
        toast.error(result.errors[0]?.message ?? "No se pudo desactivar.")
        return
      }
      setStatus("draft")
      toast.success("Automatización desactivada: ya no tiene horario.")
      router.refresh()
    })
  }

  const remove = () => {
    startAction(async () => {
      const result = await deleteAutomationAction(automationId)
      if (!result.ok) {
        toast.error(result.errors[0]?.message ?? "No se pudo eliminar.")
        return
      }
      toast.success("Automatización eliminada")
      router.push("/workflows")
    })
  }

  const adoptTrigger = (trigger: AutomationTrigger) => {
    setBase((current) => ({ ...current, trigger }))
    setSavedJson(definitionKey({ ...definition, trigger }))
    router.refresh()
  }

  const applyGodfather = (next: AutomationDefinition) => {
    startAction(async () => {
      const result = await applyGodfatherProposalAction({ id: automationId, definition: next })
      if (!result.ok) {
        toast.error(result.errors[0]?.message ?? "No se pudo aplicar la propuesta.")
        return
      }
      applyServerDefinition(next, result.version, result.status)
      router.refresh()
    })
  }

  const savingLabel =
    saveState === "saving"
      ? "Guardando…"
      : saveState === "error"
        ? "Sin guardar"
        : dirty
          ? "Cambios sin guardar"
          : savedAt
            ? "Guardado"
            : "Guardado"

  return (
    <div className="flex h-svh flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="h-8 w-48 border-transparent bg-transparent px-2 text-base font-semibold shadow-none focus-visible:border-border md:w-64"
          aria-label="Nombre de la automatización"
        />

        <Badge
          variant={
            status === "active"
              ? "default"
              : status === "error"
                ? "destructive"
                : status === "pending_approval"
                  ? "secondary"
                  : "outline"
          }
        >
          {STATUS_LABEL[status] ?? status}
        </Badge>
        <span className="text-[11px] text-muted-foreground">v{version}</span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {saveState === "saving" && <Spinner className="size-3" />}
          {savingLabel}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            disabled={saveState === "saving"}
            onClick={() => {
              startAction(async () => {
                const ok = await save(definition, { silent: false })
                if (ok) {
                  toast.success("Automatización guardada")
                  router.refresh()
                }
              })
            }}
          >
            <Save className="size-3.5" />
            Guardar
          </Button>

          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => setScheduleOpen(true)}
          >
            <CalendarClock className="size-3.5" />
            Horario
          </Button>

          {liveRun ? (
            <Button size="sm" variant="destructive" className="h-8 gap-1.5" onClick={stop} disabled={isActing}>
              <Square className="size-3.5" />
              Detener
            </Button>
          ) : (
            <Button size="sm" className="h-8 gap-1.5" onClick={run} disabled={isRunning || report.errors.length > 0}>
              {isRunning ? <Spinner className="size-3.5" /> : <Play className="size-3.5" />}
              Ejecutar
            </Button>
          )}

          {status === "active" || status === "paused" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={togglePause}
                disabled={isActing}
              >
                {status === "paused" ? "Reanudar" : "Pausar"}
              </Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={deactivate} disabled={isActing}>
                Desactivar
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              className="h-8 gap-1.5"
              onClick={() => setApprovalOpen(true)}
              disabled={report.errors.length > 0 || isActing}
            >
              <ShieldCheck className="size-3.5" />
              Activar
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="icon" variant="ghost" className="size-8" aria-label="Más acciones" />}
            >
              <Trash2 className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onSelect={remove}>
                <Trash2 className="size-3.5" />
                Eliminar automatización
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {report.errors.length > 0 && (
        <div className="border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
          <p className="flex items-center gap-1.5 font-medium">
            <CircleAlert className="size-3.5" />
            {report.errors.length === 1
              ? "Hay un problema que impide ejecutar el flujo"
              : `Hay ${report.errors.length} problemas que impiden ejecutar el flujo`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {report.errors.slice(0, 3).map((issue: ValidationIssue) => (
              <li key={`${issue.code}-${issue.nodeId ?? "flow"}`}>· {issue.message}</li>
            ))}
          </ul>
        </div>
      )}

      {report.errors.length === 0 && report.warnings.length > 0 && (
        <div className="border-b border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <span className="flex items-center gap-1.5">
            <TriangleAlert className="size-3.5" />
            {report.warnings[0]?.message}
            {report.warnings.length > 1 && ` (+${report.warnings.length - 1})`}
          </span>
        </div>
      )}

      <ReactFlowProvider>
        <RunStepsProvider steps={stepStates} live={hasLiveRun}>
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1">
              <Canvas
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                liveLabel={liveRun ? `Ejecutando · v${liveRun.version}` : undefined}
              />
            </div>
            <RightSidebar
              automationId={automationId}
              version={version}
              onApplyDefinition={applyGodfather}
            />
          </div>
        </RunStepsProvider>
      </ReactFlowProvider>

      <section className="h-52 shrink-0 border-t border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <h2 className="text-xs font-semibold">Historial de ejecuciones</h2>
          <span className="text-[11px] text-muted-foreground">
            {runs.length} {runs.length === 1 ? "ejecución" : "ejecuciones"}
          </span>
        </div>
        <div className="h-[calc(100%-2rem)]">
          <HistoryPanel runs={runs} onChanged={() => router.refresh()} />
        </div>
      </section>

      <ApprovalDialog
        automationId={automationId}
        open={approvalOpen}
        onOpenChange={setApprovalOpen}
        onActivated={() => {
          setStatus("active")
          router.refresh()
        }}
      />

      {scheduleOpen && (
        <ScheduleDialog
          automationId={automationId}
          trigger={base.trigger}
          open
          onOpenChange={setScheduleOpen}
          onSaved={adoptTrigger}
        />
      )}
    </div>
  )
}
