"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { Send, Sparkles, Wand2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { godfatherProposalAction } from "@/actions/automations"
import type { AutomationDefinition } from "@/lib/automations/definition"
import { approvalSummary } from "@/lib/automations/summary"
import { cn } from "@/lib/utils"

// Godfather, inside Automations.
//
// It is not the general chat: it receives this flow, answers about this flow and
// returns a new definition for it. Nothing is applied until the person accepts,
// and nothing is activated here at all.

type Turn = { role: "user" | "assistant"; text: string }

export function GodfatherPanel({
  automationId,
  version,
  onApply,
}: {
  automationId: string
  version: number
  onApply: (definition: AutomationDefinition) => void
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState("")
  const [isPending, startTransition] = useTransition()
  const [proposal, setProposal] = useState<AutomationDefinition | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [turns, proposal])

  const submit = () => {
    const instruction = input.trim()
    if (!instruction || isPending) return

    setTurns((current) => [...current, { role: "user", text: instruction }])
    setInput("")
    setProposal(null)

    startTransition(async () => {
      const result = await godfatherProposalAction({
        id: automationId,
        instruction,
        history: turns.slice(-6),
      })

      if (!result.ok && !("message" in result && result.message)) {
        const message = result.errors?.[0]?.message ?? "Godfather no pudo responder."
        setTurns((current) => [...current, { role: "assistant", text: message }])
        toast.error(message)
        return
      }

      const text =
        "message" in result && result.message
          ? result.message
          : "No pude construir una versión válida con eso."

      setTurns((current) => [...current, { role: "assistant", text }])

      if (!result.ok) {
        const problems = (result.errors ?? []).map((issue) => issue.message)
        if (problems.length > 0) {
          setTurns((current) => [
            ...current,
            { role: "assistant", text: problems.slice(0, 4).join("\n") },
          ])
        }
        return
      }

      if ("definition" in result && result.definition) {
        setProposal(result.definition)
      }
    })
  }

  const apply = () => {
    if (!proposal) return
    onApply(proposal)
    setProposal(null)
    setTurns((current) => [
      ...current,
      { role: "assistant", text: "Aplicado al lienzo. Guárdalo o actívalo cuando quieras." },
    ])
    toast.success("Flujo aplicado al lienzo")
  }

  const summary = proposal ? approvalSummary(proposal) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-y border-border bg-card px-3 py-1.5 text-sm font-semibold">
        <Sparkles className="size-4 text-primary" />
        Crear con Godfather
        <span className="ml-auto text-[10px] font-normal text-muted-foreground">
          v{version}
        </span>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {turns.length === 0 && (
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>Cuéntale qué debe hacer esta automatización. Él añade, cambia o quita bloques aquí mismo.</p>
            <div className="space-y-1.5">
              {[
                "Todos los lunes a las 9:00, envíame un correo con el resumen.",
                "Añade una condición: si falla la lectura, que me avise.",
                "Quita el bloque de correo y déjalo solo en un borrador.",
              ].map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setInput(example)}
                  className="block w-full rounded-md border border-border/60 p-2 text-left text-[11px] hover:bg-accent"
                >
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
              "rounded-lg px-2.5 py-2 text-xs whitespace-pre-wrap",
              turn.role === "user"
                ? "ml-6 bg-primary text-primary-foreground"
                : "mr-4 bg-muted text-foreground"
            )}
          >
            {turn.text}
          </div>
        ))}

        {isPending && (
          <div className="mr-4 flex items-center gap-2 rounded-lg bg-muted px-2.5 py-2 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Construyendo y validando…
          </div>
        )}

        {proposal && summary && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-xs">
            <p className="font-medium">Propuesta lista</p>
            <p className="mt-1 text-muted-foreground">{summary.trigger}</p>
            <p className="text-muted-foreground">
              {summary.nodeCount} bloques · {summary.target === "local" ? "tu equipo" : summary.target === "hybrid" ? "nube y equipo" : "nube"}
            </p>
            {summary.effects.length > 0 && (
              <p className="mt-1 text-muted-foreground">
                Efectos: {summary.effects.join(", ")}.
              </p>
            )}
            <Button size="sm" className="mt-2 w-full gap-1.5" onClick={apply}>
              <Wand2 className="size-3.5" />
              Aplicar al lienzo
            </Button>
          </div>
        )}
      </div>

      <div className="border-t border-border p-2">
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder="Describe el cambio…"
          className="min-h-16 text-xs"
        />
        <Button
          size="sm"
          className="mt-2 w-full gap-1.5"
          onClick={submit}
          disabled={isPending || !input.trim()}
        >
          <Send className="size-3.5" />
          Pedir a Godfather
        </Button>
      </div>
    </div>
  )
}
