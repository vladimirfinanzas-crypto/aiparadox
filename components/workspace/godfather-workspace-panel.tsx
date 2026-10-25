"use client"

import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  ArrowRightIcon,
  CheckIcon,
  RotateCcwIcon,
  SendIcon,
  SparklesIcon,
  Wand2Icon,
} from "lucide-react"
import { toast } from "sonner"

import {
  applyWorkspaceProposalAction,
  createWorkspaceFromProposalAction,
  workspaceGodfatherAction,
  type WorkspaceProposal,
} from "@/actions/workspace"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { PanelBlock, PanelDocument } from "@/lib/panels/document"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Godfather, inside Workspace.
//
// This is not the general chat and it never redirects there: it carries the
// panel the person has open, answers about that panel, and returns a new
// document for it. Nothing is written until the person accepts, and an accepted
// change is saved as a new version of the same panel.
// ---------------------------------------------------------------------------

type Turn = { role: "user" | "assistant"; text: string }

const examplesNew = [
  "Un panel para seguir mis tareas con estado y fecha límite.",
  "Un registro de entrenamientos: tipo, duración y series.",
  "Un calendario de publicaciones para mis redes.",
]

const examplesEdit = [
  "Añade una columna de prioridad a la tabla.",
  "Reordena las secciones: primero el resumen.",
  "Añade un formulario para registrar sesiones.",
]

function blockPreview(block: PanelBlock): string {
  switch (block.type) {
    case "heading":
      return block.text || "Título"
    case "text":
      return block.text.slice(0, 60) || "Texto"
    case "table":
      return block.title || `Tabla · ${block.columns.join(", ")}`
    case "checklist":
      return block.title || "Checklist"
    case "list":
      return block.title || "Lista"
    case "calendar":
      return block.title || "Calendario"
    case "form":
      return block.title || "Formulario"
    case "chart":
      return block.title || "Gráfico"
    case "stats":
      return block.title || "Métricas"
  }
}

function documentOutline(document: PanelDocument) {
  return document.blocks.slice(0, 8).map((block, index) => ({
    key: `${block.id}-${index}`,
    type: block.type,
    label: blockPreview(block),
  }))
}

export function GodfatherWorkspacePanel({
  panelId,
  panelName,
  version,
  onSaved,
  onCreated,
  className,
}: {
  panelId?: string | null
  panelName?: string
  version?: number
  onSaved?: (version: number) => void
  onCreated?: (panelId: string) => void
  className?: string
}) {
  const router = useRouter()
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState("")
  const [proposal, setProposal] = useState<WorkspaceProposal | null>(null)
  const [proposedName, setProposedName] = useState("")
  const [isPending, startTransition] = useTransition()
  const [isApplying, startApplying] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  const editing = Boolean(panelId)
  const examples = editing ? examplesEdit : examplesNew

  const scrollToEnd = () => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }

  const submit = (text?: string) => {
    const instruction = (text ?? input).trim()
    if (!instruction || isPending) return

    setError(null)
    setTurns((current) => [...current, { role: "user", text: instruction }])
    setInput("")
    setProposal(null)

    startTransition(async () => {
      const result = await workspaceGodfatherAction({
        panelId: panelId ?? null,
        instruction,
        history: turns.slice(-6),
      })

      setTurns((current) => [...current, { role: "assistant", text: result.message }])

      if (!result.ok || !result.proposal) {
        // The text the person typed is already in the transcript; the input is
        // left empty on purpose so they can send a corrected request.
        setError(result.issues.length > 0 ? result.issues.join(" ") : null)
        scrollToEnd()
        return
      }

      setProposal(result.proposal)
      setProposedName(result.proposal.name ?? result.panelName)
      scrollToEnd()
    })
  }

  const apply = () => {
    if (!proposal || !panelId) return

    startApplying(async () => {
      const result = await applyWorkspaceProposalAction({ panelId, proposal })
      if (!result.ok) {
        setError(result.error)
        toast.error(result.error)
        return
      }

      setProposal(null)
      setTurns((current) => [
        ...current,
        {
          role: "assistant",
          text: `Guardado como versión ${result.version}. Ya está en el panel y tus datos siguen ahí.`,
        },
      ])
      toast.success(`Cambio guardado · versión ${result.version}`)
      onSaved?.(result.version)
      router.refresh()
      scrollToEnd()
    })
  }

  const create = () => {
    if (!proposal) return

    startApplying(async () => {
      const result = await createWorkspaceFromProposalAction({
        name: proposedName,
        proposal,
      })

      if (!result.ok) {
        setError(result.error)
        toast.error(result.error)
        return
      }

      toast.success("Herramienta creada")
      onCreated?.(result.panelId)
      router.push(`/widgets/${result.panelId}`)
    })
  }

  const outline = proposal ? documentOutline(proposal.document) : []

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <SparklesIcon className="size-4 text-primary" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {editing ? `Cambiar «${panelName}»` : "Crear con Godfather"}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {editing
              ? `Trabaja sobre esta herramienta y guarda una versión nueva${version ? ` (v${version})` : ""}`
              : "Describe la herramienta y él la construye"}
          </p>
        </div>
      </div>

      <div
        ref={scroller}
        aria-live="polite"
        className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3"
      >
        {turns.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {editing
                ? "Dile qué quieres cambiar. Mantendré las secciones que usas y sus datos."
                : "Cuéntale para qué necesitas la herramienta. En cuanto la construya podrás crearla y usarla."}
            </p>
            <div className="space-y-1.5">
              {examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => submit(example)}
                  disabled={isPending}
                  className="flex w-full items-start gap-2 rounded-lg border border-border/50 bg-background/40 px-2.5 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-60"
                >
                  <ArrowRightIcon className="mt-0.5 size-3 shrink-0" />
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, index) => (
          <div
            key={`${turn.role}-${index}`}
            className={cn(
              "max-w-[95%] rounded-xl px-3 py-2 text-xs whitespace-pre-wrap",
              turn.role === "user"
                ? "ml-auto bg-primary text-primary-foreground"
                : "bg-muted text-foreground"
            )}
          >
            {turn.text}
          </div>
        ))}

        {isPending && (
          <div className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Construyendo la herramienta…
          </div>
        )}

        {proposal && (
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-xs">
            <p className="flex items-center gap-1.5 font-medium">
              <CheckIcon className="size-3.5 text-primary" />
              {editing ? "Cambios listos" : "Herramienta lista"}
            </p>
            {proposal.description && (
              <p className="mt-1 text-muted-foreground">{proposal.description}</p>
            )}
            <ul className="mt-2 space-y-0.5 text-muted-foreground">
              {outline.map((item) => (
                <li key={item.key} className="truncate">
                  · {item.label}
                </li>
              ))}
              {proposal.document.blocks.length > outline.length && (
                <li>· y {proposal.document.blocks.length - outline.length} más</li>
              )}
            </ul>

            {editing ? (
              <Button
                size="sm"
                className="mt-3 w-full gap-1.5"
                onClick={apply}
                disabled={isApplying}
              >
                {isApplying ? <Spinner /> : <Wand2Icon className="size-3.5" />}
                Aplicar a la herramienta
              </Button>
            ) : (
              <div className="mt-3 space-y-2">
                <Input
                  value={proposedName}
                  onChange={(event) => setProposedName(event.target.value)}
                  aria-label="Nombre de la herramienta"
                  maxLength={60}
                  className="h-8 text-xs"
                />
                <Button
                  size="sm"
                  className="w-full gap-1.5"
                  onClick={create}
                  disabled={isApplying || !proposedName.trim()}
                >
                  {isApplying ? <Spinner /> : <Wand2Icon className="size-3.5" />}
                  Crear herramienta
                </Button>
              </div>
            )}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
          >
            {error}
          </div>
        )}

        {editing && turns.length > 0 && !proposal && !isPending && (
          <button
            type="button"
            onClick={() => submit(turns.filter((t) => t.role === "user").at(-1)?.text ?? "")}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <RotateCcwIcon className="size-3" />
            Reintentar la última petición
          </button>
        )}
      </div>

      <div className="border-t border-border/60 p-3">
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={
            editing ? "¿Qué quieres cambiar?" : "¿Qué herramienta necesitas?"
          }
          className="min-h-16 resize-none text-xs"
          disabled={isPending || isApplying}
          maxLength={2000}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            Enter envía · Shift+Enter salta de línea
          </span>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => submit()}
            disabled={isPending || isApplying || !input.trim()}
          >
            {isPending ? <Spinner /> : <SendIcon className="size-3.5" />}
            Enviar
          </Button>
        </div>
      </div>
    </div>
  )
}
