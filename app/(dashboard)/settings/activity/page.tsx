import { auth } from "@clerk/nextjs/server"
import { format, formatDistanceToNowStrict } from "date-fns"
import {
  ActivityIcon,
  CheckCircle2Icon,
  ClockIcon,
  GlobeIcon,
  MessageSquareIcon,
  MonitorIcon,
  WorkflowIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { usageLimits } from "@/lib/usage"
import { getActivityOverview, type ActivityEvent } from "@/queries/activity"
import { cn } from "@/lib/utils"

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const hours = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })

const eventIcon = {
  chat: MessageSquareIcon,
  automation: WorkflowIcon,
  desktop: MonitorIcon,
  tool: WrenchIcon,
  browser: GlobeIcon,
} as const

const filters = [
  { id: "all", label: "Todo" },
  { id: "chat", label: "Conversaciones" },
  { id: "tool", label: "Herramientas" },
  { id: "automation", label: "Automatizaciones" },
  { id: "browser", label: "Navegador" },
  { id: "desktop", label: "Escritorio" },
] as const

type FilterId = (typeof filters)[number]["id"]

function isFilter(value: string | undefined): value is FilterId {
  return filters.some((filter) => filter.id === value)
}

function UsageMeter({
  title,
  description,
  used,
  limit,
  detail,
}: {
  title: string
  description: string
  used: number
  limit: number
  detail: string
}) {
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border/40 bg-card/50 p-4 backdrop-blur-xl">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        <span className="text-xs tabular-nums text-muted-foreground">
          {percent}%
        </span>
      </div>
      <Progress value={percent} aria-label={title} />
      <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>{description}</span>
        <span className="tabular-nums">{detail}</span>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const failed = status === "failed" || status === "error"
  const running =
    status === "pending" ||
    status === "claimed" ||
    status === "running" ||
    status === "queued" ||
    status === "awaiting_execution_environment"

  if (failed) {
    return (
      <Badge variant="destructive">
        <XCircleIcon data-icon="inline-start" />
        {status}
      </Badge>
    )
  }
  if (running) {
    return (
      <Badge variant="secondary">
        <ClockIcon data-icon="inline-start" />
        {status}
      </Badge>
    )
  }
  return (
    <Badge variant="outline">
      <CheckCircle2Icon data-icon="inline-start" />
      {status}
    </Badge>
  )
}

function EventRow({ event }: { event: ActivityEvent }) {
  const Icon = eventIcon[event.kind]

  const content = (
    <div className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="truncate text-sm font-medium">{event.title}</p>
          <span className="text-[11px] text-muted-foreground">
            {formatDistanceToNowStrict(event.at)} atrás
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground">{event.detail}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <StatusBadge status={event.status} />
        <time
          dateTime={event.at.toISOString()}
          className="text-[11px] text-muted-foreground"
        >
          {format(event.at, "d MMM HH:mm")}
        </time>
      </div>
    </div>
  )

  return (
    <li>
      {event.href ? (
        <Link href={event.href} className="block transition-colors hover:bg-muted/50">
          {content}
        </Link>
      ) : (
        content
      )}
    </li>
  )
}

// Settings → Activity. One history for everything the person's agents did, with
// the type filter in the URL so a reload or a shared link keeps the same view.
export default async function SettingsActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>
}) {
  await auth.protect()

  const { kind } = await searchParams
  const active: FilterId = isFilter(kind) ? kind : "all"

  const { events, usage } = await getActivityOverview()
  const visible =
    active === "all" ? events : events.filter((event) => event.kind === active)

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="consumption" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="consumption" className="font-semibold tracking-tight">
            Consumo · últimos 30 días
          </h2>
          <p className="text-sm text-muted-foreground">
            Lo que gastaron los agentes: tokens de los modelos, horas de
            ejecución, sesiones de navegador y publicaciones.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <UsageMeter
            title="IA"
            description="Tokens de los modelos"
            used={usage.ai}
            limit={usageLimits.ai}
            detail={`${dollars.format(usage.ai / 1_000_000)} de ${dollars.format(usageLimits.ai / 1_000_000)}`}
          />
          <UsageMeter
            title="Sandbox"
            description="Horas de ejecución"
            used={usage.sandbox}
            limit={usageLimits.sandbox}
            detail={`${hours.format(usage.sandbox / 3600)} de ${hours.format(usageLimits.sandbox / 3600)} h`}
          />
          <UsageMeter
            title="Navegador"
            description="Sesiones remotas"
            used={usage.browser}
            limit={usageLimits.browser}
            detail={`${hours.format(usage.browser / 3600)} de ${hours.format(usageLimits.browser / 3600)} h`}
          />
          <UsageMeter
            title="Redes sociales"
            description="Publicaciones"
            used={usage.social}
            limit={usageLimits.social}
            detail={`${usage.social} de ${usageLimits.social}`}
          />
        </div>
      </section>

      <section aria-labelledby="timeline" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="timeline" className="font-semibold tracking-tight">
            Historial
          </h2>
          <Link
            href="/chats"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Ir al agente
          </Link>
        </div>

        <nav aria-label="Filtrar actividad">
          <ul className="-mx-1 flex flex-wrap items-center gap-1 px-1">
            {filters.map((filter) => {
              const isActive = filter.id === active
              return (
                <li key={filter.id}>
                  <Link
                    href={
                      filter.id === "all" ? "/settings/activity" : `/settings/activity?kind=${filter.id}`
                    }
                    aria-current={isActive ? "true" : undefined}
                    className={cn(
                      "block rounded-full border px-3 py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                      isActive
                        ? "border-primary/40 bg-primary/10 font-medium text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    {filter.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>

        {visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed p-10 text-center">
            <ActivityIcon className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-2 font-medium">
              {active === "all"
                ? "Todavía no hay actividad"
                : "Nada en este filtro todavía"}
            </p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              {active === "all"
                ? "Pide una tarea al agente o crea una automatización y sus pasos aparecerán aquí."
                : "Cuando haya eventos de este tipo aparecerán en esta lista. Cambia el filtro para ver el resto."}
            </p>
          </div>
        ) : (
          <ol className="flex flex-col divide-y divide-border/40 overflow-hidden rounded-2xl border border-border/40 bg-card/40">
            {visible.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ol>
        )}

        <p className="text-xs text-muted-foreground">
          Una publicación o un correo solo aparecen aquí cuando la API los
          confirmó; los pasos de una automatización, cuando el motor los registró.
        </p>
      </section>
    </div>
  )
}
