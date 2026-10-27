import { auth } from "@clerk/nextjs/server"
import { formatDistanceToNowStrict } from "date-fns"
import { ArrowRightIcon, CalendarClockIcon, WorkflowIcon } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { NewAutomationButton } from "@/features/workflows/components/new-automation-button"
import { HistoryToggle } from "@/features/workflows/components/history-toggle"
import { describeTrigger } from "@/lib/automations/summary"
import { listAutomations, listGlobalRunViews } from "@/queries/automations"

const STATUS: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  draft: { label: "Borrador", variant: "outline" },
  pending_approval: { label: "Pendiente de autorización", variant: "secondary" },
  active: { label: "Activa", variant: "default" },
  paused: { label: "Pausada", variant: "outline" },
  error: { label: "Error", variant: "destructive" },
}

// The Automations list. Everything on a card comes from the database — status,
// next run, last run — so it agrees with what the runner will actually do.
export default async function WorkflowsPage() {
  await auth.protect()

  const { userId } = await auth()
  if (!userId) throw new Error("Unauthorized")

  const [automations, history] = await Promise.all([
    listAutomations(userId),
    listGlobalRunViews({ userId, limit: 25 }),
  ])

  if (automations.length === 0) {
    return (
      <Empty className="min-h-svh border-none">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WorkflowIcon />
          </EmptyMedia>
          <EmptyTitle>No hay automatizaciones todavía</EmptyTitle>
          <EmptyDescription>
            Describe lo que quieres que ocurra —«cada lunes envíame el resumen»— y
            Godfather construye el flujo contigo. También puedes armarlo bloque a
            bloque en el editor, probarlo y programarlo.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <NewAutomationButton label="Crear la primera" />
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Automations</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Procesos que se repiten solos. Cada ejecución guarda sus pasos, sus
            tiempos y el error si algo falla, y puedes abrirla después.
          </p>
        </div>
        <NewAutomationButton />
      </div>

      <HistoryToggle runs={history} />

      <ul className="grid gap-3 sm:grid-cols-2">
        {automations.map((automation) => {
          const status = STATUS[automation.status] ?? STATUS.draft!
          const trigger = automation.trigger

          return (
            <li key={automation.id}>
              <Link
                href={`/workflows/${automation.id}`}
                className="group flex h-full flex-col gap-3 rounded-2xl border border-border/40 bg-card/50 p-4 backdrop-blur-xl transition-colors hover:bg-muted/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
                    <WorkflowIcon className="size-4" aria-hidden />
                  </span>
                  <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </div>

                <div>
                  <p className="truncate font-medium">{automation.name}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CalendarClockIcon className="size-3.5" aria-hidden />
                    {trigger ? describeTrigger(trigger) : "Sin disparador"}
                  </p>
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-2">
                  <Badge variant={status.variant}>{status.label}</Badge>
                  <Badge variant="outline">
                    {automation.nodeCount}{" "}
                    {automation.nodeCount === 1 ? "bloque" : "bloques"}
                  </Badge>
                  {automation.nextRunAt && automation.status === "active" && (
                    <span className="text-[11px] text-muted-foreground">
                      Próxima {formatDistanceToNowStrict(automation.nextRunAt)} atrás
                    </span>
                  )}
                  {automation.lastRunAt && (
                    <span className="text-[11px] text-muted-foreground">
                      Última {formatDistanceToNowStrict(automation.lastRunAt)} atrás
                    </span>
                  )}
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    v{automation.version}
                  </span>
                </div>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
