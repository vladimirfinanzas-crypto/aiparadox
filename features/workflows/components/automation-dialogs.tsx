"use client"

import { useEffect, useState, useTransition } from "react"
import { CalendarClock, ShieldCheck } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  approveAndActivateAction,
  previewApprovalAction,
  updateTriggerAction,
} from "@/actions/automations"
import type { AutomationTrigger } from "@/lib/automations/definition"
import type { ApprovalSummary } from "@/lib/automations/summary"

// Two moments where the person has to decide something the flow cannot decide
// for them: when it starts running by itself, and what "by itself" means.

export function ApprovalDialog({
  automationId,
  open,
  onOpenChange,
  onActivated,
}: {
  automationId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onActivated: () => void
}) {
  const [summary, setSummary] = useState<ApprovalSummary | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) return
    let cancelled = false

    previewApprovalAction({ id: automationId }).then((result) => {
      if (cancelled) return
      setSummary(result.summary)
      setProblems(result.errors.map((issue) => issue.message))
    })

    return () => {
      cancelled = true
    }
  }, [open, automationId])

  const activate = () => {
    startTransition(async () => {
      const result = await approveAndActivateAction({ id: automationId })
      if (!result.ok) {
        toast.error(result.errors[0]?.message ?? "No se pudo activar.")
        return
      }
      toast.success("Automatización activa")
      onOpenChange(false)
      onActivated()
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" />
            Revisar y activar
          </DialogTitle>
          <DialogDescription>
            Esto es lo que hará la automatización sin que estés delante. Se guarda
            como la autorización de esta versión: si cambias lo que hace, habrá que
            revisarla otra vez.
          </DialogDescription>
        </DialogHeader>

        {!summary ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Cargando la revisión…
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div>
              <p className="font-medium">{summary.name}</p>
              <p className="text-muted-foreground">{summary.trigger}</p>
            </div>

            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt className="text-muted-foreground">Dónde se ejecuta</dt>
                <dd className="font-medium">
                  {summary.target === "local"
                    ? "Tu equipo (Desktop Agent)"
                    : summary.target === "hybrid"
                      ? "Nube y tu equipo"
                      : "Nube"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Bloques</dt>
                <dd className="font-medium">{summary.nodeCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Zona horaria</dt>
                <dd className="font-medium">{summary.timezone}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Integraciones</dt>
                <dd className="font-medium">
                  {summary.integrations.length > 0 ? summary.integrations.join(", ") : "Ninguna"}
                </dd>
              </div>
            </dl>

            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                Acciones con efectos externos
              </p>
              {summary.actions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Ninguna: este flujo no envía, publica ni controla nada fuera de Paradox.
                </p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {summary.actions.map((action) => (
                    <li key={action.nodeId} className="rounded-md border border-border/60 p-2">
                      <p className="font-medium">{action.label}</p>
                      {action.details && (
                        <p className="text-muted-foreground">{action.details}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {problems.length > 0 && (
              <ul className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                {problems.slice(0, 4).map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={activate} disabled={isPending || problems.length > 0}>
            {isPending && <Spinner className="size-3.5" />}
            Autorizar y activar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Cada día a las 9:00", cron: "0 9 * * *" },
  { label: "Cada lunes a las 9:00", cron: "0 9 * * 1" },
  { label: "Cada viernes a las 18:00", cron: "0 18 * * 5" },
  { label: "Cada hora", cron: "0 * * * *" },
]

export function ScheduleDialog({
  automationId,
  trigger,
  open,
  onOpenChange,
  onSaved,
}: {
  automationId: string
  trigger: AutomationTrigger
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (trigger: AutomationTrigger) => void
}) {
  const [kind, setKind] = useState<AutomationTrigger["kind"]>(trigger.kind)
  const [cron, setCron] = useState(trigger.cron ?? "0 9 * * 1")
  const [timezone, setTimezone] = useState(trigger.timezone || "UTC")
  const [runAt, setRunAt] = useState(trigger.runAt?.slice(0, 16) ?? "")
  const [isPending, startTransition] = useTransition()

  const save = () => {
    startTransition(async () => {
      const nextTrigger: AutomationTrigger = {
        kind,
        timezone,
        ...(kind === "cron" ? { cron } : {}),
        ...(kind === "once"
          ? { runAt: runAt ? new Date(runAt).toISOString() : undefined }
          : {}),
      }

      const result = await updateTriggerAction({
        id: automationId,
        trigger: nextTrigger,
      })

      if (!result.ok) {
        toast.error(result.errors[0]?.message ?? "No se pudo guardar la frecuencia.")
        return
      }

      toast.success(
        kind === "manual"
          ? "La automatización solo se ejecutará cuando la pidas."
          : "Frecuencia guardada."
      )
      onOpenChange(false)
      onSaved(nextTrigger)
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="size-4 text-primary" />
            Cuándo se ejecuta
          </DialogTitle>
          <DialogDescription>
            El horario se guarda en la nube: sigue funcionando aunque cierres esta
            página o apagues el equipo.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Disparador</Label>
            <Select value={kind} onValueChange={(value) => setKind(value as AutomationTrigger["kind"])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Solo manual</SelectItem>
                <SelectItem value="cron">Recurrente</SelectItem>
                <SelectItem value="once">Una sola vez</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {kind === "cron" && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Frecuencia</Label>
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map((preset) => (
                    <Button
                      key={preset.cron}
                      size="sm"
                      variant={cron === preset.cron ? "secondary" : "outline"}
                      className="text-xs"
                      onClick={() => setCron(preset.cron)}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
                <Input value={cron} onChange={(event) => setCron(event.target.value)} />
                <p className="text-[11px] text-muted-foreground">
                  Expresión cron de cinco campos (minuto, hora, día, mes, día de la semana).
                </p>
              </div>
            </>
          )}

          {kind === "once" && (
            <div className="space-y-1.5">
              <Label className="text-xs">Fecha y hora</Label>
              <Input
                type="datetime-local"
                value={runAt}
                onChange={(event) => setRunAt(event.target.value)}
              />
            </div>
          )}

          {kind !== "manual" && (
            <div className="space-y-1.5">
              <Label className="text-xs">Zona horaria</Label>
              <Input
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                placeholder="Europe/Madrid"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={isPending}>
            {isPending && <Spinner className="size-3.5" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
