"use client"

import { CloudIcon, MonitorIcon } from "lucide-react"
import { useState, useTransition } from "react"

import { resolveExecutionEnvironment } from "@/actions/execution"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// The environment question, as a control rather than a decoration.
//
// It is rendered from the output of `request_execution_environment`, so the
// task it answers for is the task Godfather actually created. The click goes to
// a server action that re-checks ownership and status; if the answer is accepted
// the chat sends the resume line and the turn continues in that environment.
// ---------------------------------------------------------------------------

type Option = {
  id: string
  label: string
  description?: string
  disabled?: boolean
}

export type EnvironmentCardOutput = {
  status: string
  taskId?: string
  question?: string | null
  options?: Option[] | null
  environment?: "local" | "cloud" | null
  reason?: string | null
}

function iconFor(id: string) {
  if (id === "cloud") return CloudIcon
  if (id === "local") return MonitorIcon
  return null
}

export function ExecutionEnvironmentCard({
  output,
  onResume,
}: {
  output: EnvironmentCardOutput
  /** Sends the resume message; the card never talks to the task itself. */
  onResume?: (text: string) => void
}) {
  const [pending, startTransition] = useTransition()
  const [answer, setAnswer] = useState<{
    status: "selected" | "cancelled" | "rejected"
    message: string
    environment?: "local" | "cloud"
  } | null>(null)

  // A task without an id (api/direct/unavailable answers) is not a question.
  const question = output.question
  const options = output.options ?? []
  const isQuestion =
    output.status === "awaiting_execution_environment" &&
    Boolean(output.taskId) &&
    options.length > 0

  if (!isQuestion) {
    const label =
      output.status === "selected"
        ? output.environment === "local"
          ? "Navegador de tu PC"
          : "Navegador cloud (Browserbase)"
        : output.status === "unavailable"
          ? "Ese entorno no está disponible ahora mismo"
          : null

    if (!label) return null

    return (
      <p className="text-sm text-muted-foreground">
        {label}
        {output.status === "unavailable" && output.reason
          ? ` — ${output.reason}`
          : ""}
      </p>
    )
  }

  const taskId = output.taskId as string

  function choose(choice: string) {
    startTransition(async () => {
      const result = await resolveExecutionEnvironment({
        taskId,
        choice: choice as "local" | "cloud" | "cancel",
      })

      if (result.status === "rejected") {
        setAnswer({ status: "rejected", message: result.message })
        return
      }
      if (result.status === "cancelled") {
        setAnswer({ status: "cancelled", message: result.message })
        return
      }

      setAnswer({
        status: "selected",
        message: result.message,
        environment: result.environment,
      })
      // Only a first, accepted choice resumes the conversation: a repeated
      // click has no resume text, so it cannot start the task again.
      if (result.resumeText) onResume?.(result.resumeText)
    })
  }

  return (
    <div
      data-slot="execution-environment-card"
      className="w-full rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10"
    >
      <p className="font-medium">{question}</p>
      <p className="mt-1 text-muted-foreground">
        La tarea queda en espera: no se abrirá ninguna página hasta que elijas.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {options
          .filter((option) => option.id !== "cancel")
          .map((option) => {
            const Icon = iconFor(option.id)
            const chosen = answer?.environment === option.id
            return (
              <button
                key={option.id}
                type="button"
                disabled={pending || Boolean(answer) || option.disabled}
                onClick={() => choose(option.id)}
                className={cn(
                  "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                  "hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60",
                  chosen && "border-primary bg-primary/5"
                )}
              >
                <span className="flex items-center gap-2 font-medium">
                  {Icon ? <Icon className="size-4" aria-hidden /> : null}
                  {option.label}
                </span>
                {option.description ? (
                  <span className="text-xs text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </button>
            )
          })}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {answer?.message ?? "Elige dónde quieres que se ejecute."}
        </p>
        {!answer ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => choose("cancel")}
          >
            {pending ? "…" : "Cancelar"}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
