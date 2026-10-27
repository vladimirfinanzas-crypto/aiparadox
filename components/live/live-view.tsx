"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  ActivityIcon,
  ArrowUpRightIcon,
  GlobeIcon,
  LayoutDashboardIcon,
  MonitorIcon,
  RefreshCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
  WorkflowIcon,
  XCircleIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  isActive,
  progressPercent,
  relativeTime,
  sourceLabels,
  type LiveFeed,
  type LiveItem,
  type LiveSource,
  type LiveStatus,
} from "@/lib/live/view"
import { LiveSessionPanel } from "@/components/live/session-view"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Live View.
//
// A corner dock that reads `/api/live` — never its own copy of the state. It
// polls slowly while closed (just enough for the counter), faster while open,
// and pauses while the tab is hidden. Every item is a row the backend wrote;
// the panel invents nothing, so a task without a reported total shows its state
// and no bar.
// ---------------------------------------------------------------------------

const POLL_OPEN_MS = 5_000
const POLL_CLOSED_MS = 25_000

const sourceIcon: Record<LiveSource, typeof SparklesIcon> = {
  godfather: SparklesIcon,
  automation: WorkflowIcon,
  workspace: LayoutDashboardIcon,
  browser: GlobeIcon,
  desktop: MonitorIcon,
}

const statusTone: Record<LiveStatus, string> = {
  attention: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  running: "border-primary/30 bg-primary/10 text-primary",
  waiting: "border-border/60 bg-muted/60 text-muted-foreground",
  queued: "border-border/60 bg-muted/40 text-muted-foreground",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
  cancelled: "border-border/60 bg-muted/40 text-muted-foreground",
  succeeded: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
}

function ItemRow({ item }: { item: LiveItem }) {
  const Icon = sourceIcon[item.source]
  const percent = progressPercent(item.progress)

  return (
    <li className="rounded-xl border border-border/50 bg-card/40 p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-3.5" aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-1.5">
            <p className="min-w-0 text-sm font-medium">{item.title}</p>
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                statusTone[item.status]
              )}
            >
              {item.statusLabel}
            </span>
          </div>

          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {item.detail}
          </p>

          {item.progress && percent !== null && (
            <div className="mt-2">
              <Progress value={percent} aria-label={`${item.title}: progreso`} />
              <p className="mt-1 text-[10px] text-muted-foreground tabular-nums">
                {item.progress.done} de {item.progress.total} pasos
              </p>
            </div>
          )}

          {item.error && (
            <p className="mt-1.5 flex items-start gap-1 text-[11px] text-destructive">
              <XCircleIcon className="mt-px size-3 shrink-0" aria-hidden />
              <span className="line-clamp-2">{item.error}</span>
            </p>
          )}

          {item.result && !item.error && (
            <p className="mt-1 text-[11px] text-muted-foreground">{item.result}</p>
          )}

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">
              {sourceLabels[item.source]} · {relativeTime(item.updatedAt)}
            </span>
            {item.href && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px]"
                render={<Link href={item.href} />}
              >
                {item.hrefLabel ?? "Abrir"}
                <ArrowUpRightIcon className="size-3" aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </div>
    </li>
  )
}

function Section({ title, items }: { title: string; items: LiveItem[] }) {
  if (items.length === 0) return null

  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
        <span className="ml-1.5 font-normal tabular-nums opacity-70">
          {items.length}
        </span>
      </h3>
      <ul className="space-y-2">
        {items.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  )
}

export function LiveView() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [feed, setFeed] = useState<LiveFeed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const inFlight = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return
    }

    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller

    try {
      const response = await fetch("/api/live", {
        signal: controller.signal,
        cache: "no-store",
      })

      if (!response.ok) {
        throw new Error(response.status === 401 ? "session" : "server")
      }

      const body = (await response.json()) as
        | { ok: true; feed: LiveFeed }
        | { ok: false; error: string }

      if (!body.ok) throw new Error(body.error)

      // One request at a time (the previous one is aborted above), and a
      // snapshot older than the one on screen is discarded: a slow answer must
      // never push the panel back in time.
      const next = body.feed
      setFeed((current) =>
        current && Date.parse(next.generatedAt) < Date.parse(current.generatedAt)
          ? current
          : next
      )
      setError(null)
    } catch (caught) {
      if (controller.signal.aborted) return
      const reason = caught instanceof Error ? caught.message : "server"
      setError(
        reason === "session"
          ? "Tu sesión ha caducado. Recarga la página para volver a ver tus tareas."
          : "No se pudo consultar el estado. Se reintentará automáticamente."
      )
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Deferred by a tick: the first paint should not wait for the network, and
    // the fetch then updates state outside the effect body.
    const first = window.setTimeout(() => void load(), 0)

    const interval = window.setInterval(
      () => void load(),
      open ? POLL_OPEN_MS : POLL_CLOSED_MS
    )

    const onVisibility = () => {
      if (document.visibilityState === "visible") void load()
    }

    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      window.clearTimeout(first)
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [load, open])

  useEffect(() => () => inFlight.current?.abort(), [])

  const items = feed?.items ?? []
  const attention = items.filter((item) => item.status === "attention")
  const active = items.filter((item) => isActive(item.status) && item.status !== "attention")
  const recent = items.filter(
    (item) => !isActive(item.status) && item.status !== "attention"
  )
  const badge = (feed?.counts.active ?? 0) + (feed?.counts.attention ?? 0)
  const running = items.filter((item) => item.status === "running").length
  const agentOffline = Boolean(feed && feed.devices.total > 0 && feed.devices.online === 0)
  const noAgents = Boolean(feed && feed.devices.total === 0)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Abrir Live View${badge > 0 ? `, ${badge} tareas activas` : ""}`}
        aria-expanded={open}
        className={cn(
          "fixed right-4 z-40 flex items-center gap-2 rounded-full border border-border/60 bg-background/85 px-3 py-2 text-xs font-medium shadow-lg shadow-black/25 backdrop-blur-md transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none",
          // Chat pins its composer to the bottom of the screen on phones; the
          // dock steps above it there instead of covering the send button.
          pathname.startsWith("/chats")
            ? "bottom-[11rem] sm:bottom-5"
            : "bottom-4"
        )}
        style={{ marginBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <span className="relative flex size-4 items-center justify-center">
          <ActivityIcon className="size-4 text-primary" aria-hidden />
          {running > 0 && (
            <span className="absolute -top-0.5 -right-1 size-2 animate-pulse rounded-full bg-primary" />
          )}
        </span>
        <span className="hidden sm:inline">Live View</span>
        {badge > 0 && (
          <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground tabular-nums">
            {badge}
          </span>
        )}
        {error && <TriangleAlertIcon className="size-3.5 text-amber-300" aria-hidden />}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <ActivityIcon className="size-4 text-primary" aria-hidden />
              Live View
            </SheetTitle>
            <SheetDescription>
              Lo que están haciendo tus agentes ahora mismo, leído del backend.
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
            {/* The session itself: which environment the work is running in,
                and the only viewport this app can honestly provide for it. */}
            <LiveSessionPanel open={open} />

            <div
              aria-live="polite"
              className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground"
            >
              <span>
                {feed
                  ? `Actualizado a las ${new Date(feed.generatedAt).toLocaleTimeString("es-ES", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
                  : "Conectando…"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => void load()}
                disabled={loading}
              >
                <RefreshCwIcon className="size-3" aria-hidden />
                Actualizar
              </Button>
            </div>

            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-100"
              >
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{error}</span>
              </div>
            )}

            {(agentOffline || noAgents) && (
              <div className="rounded-xl border border-border/60 bg-muted/40 p-3 text-xs">
                <p className="flex items-center gap-1.5 font-medium">
                  <MonitorIcon className="size-3.5" aria-hidden />
                  {agentOffline
                    ? "Tu Desktop Agent está desconectado"
                    : "No tienes Desktop Agent instalado"}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {agentOffline
                    ? "Las tareas que necesitan tu equipo esperarán en la cola hasta que vuelva a conectarse. Lo que corre en la nube sigue funcionando."
                    : "Las tareas locales no pueden ejecutarse sin él. Todo lo demás sigue disponible."}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  render={<Link href="/settings/desktop-agent" />}
                >
                  Gestionar Desktop Agent
                </Button>
              </div>
            )}

            {loading && !feed ? (
              <div className="space-y-2" aria-busy="true">
                <div className="h-20 animate-pulse rounded-xl border border-border/40 bg-card/40" />
                <div className="h-20 animate-pulse rounded-xl border border-border/40 bg-card/40" />
              </div>
            ) : items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 p-8 text-center">
                <ActivityIcon className="mx-auto size-5 text-muted-foreground" />
                <p className="mt-2 text-sm font-medium">Todo en calma</p>
                <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
                  No hay tareas en curso. Cuando Godfather ejecute algo, una
                  automatización se lance o tu equipo reciba un trabajo,
                  aparecerá aquí.
                </p>
              </div>
            ) : (
              <>
                <Section title="Necesitan tu decisión" items={attention} />
                <Section title="En curso" items={active} />
                <Section title="Reciente" items={recent.slice(0, 8)} />
              </>
            )}

            {feed && (
              <p className="border-t border-border/40 pt-3 text-[10px] text-muted-foreground">
                Se actualiza cada {POLL_OPEN_MS / 1000} s mientras este panel está
                abierto, y se detiene cuando la pestaña está oculta. Sin
                porcentajes estimados: solo el progreso que el backend informa.
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
