"use client"

import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import Link from "next/link"
import {
  CameraIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  GlobeIcon,
  Loader2Icon,
  MonitorOffIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  TimerIcon,
} from "lucide-react"

import { Image } from "@/components/ai-elements/image"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { relativeTime } from "@/lib/live/view"
import {
  sessionEnvironmentLabels,
  type LiveSessionStatus,
  type LiveSessionView,
} from "@/lib/live/session"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// The session viewport.
//
// What it shows depends entirely on the environment, and it says which:
//
//   cloud   the task's browser runs on Browserbase, so the real-time picture is
//           Browserbase's own live view — opened in a new tab, because their
//           viewer is a full page and not embeddable.
//   local   the browser runs on the person's computer, which accepts no inbound
//           connection, so a screenshot is fetched as a job through the same
//           queue the Desktop Agent already uses. Captures, never "video".
//
// States: none / connecting / active / paused / disconnected / finished /
// error, plus a timeout so the panel never spins forever on a dead request.
// ---------------------------------------------------------------------------

const SESSION_POLL_MS = 5_000
const CAPTURE_POLL_MS = 6_000
/** Longer than any of the requests above, short enough to feel un-stuck. */
const LOAD_TIMEOUT_MS = 12_000

const statusTone: Record<LiveSessionStatus, string> = {
  none: "border-border/60 bg-muted/40 text-muted-foreground",
  connecting: "border-primary/30 bg-primary/10 text-primary",
  active: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  paused: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  disconnected: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  finished: "border-border/60 bg-muted/40 text-muted-foreground",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
}

type ViewerResponse = {
  ok: boolean
  url?: string
  error?: string
}

type SnapshotResponse =
  | { ok: true; base64: string; mediaType: string; capturedAt: string }
  | { ok: false; error?: string; message?: string }

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border/50 bg-black/40">
      {children}
    </div>
  )
}

function SessionViewport({
  session,
  snapshot,
  capturePending,
  captureError,
  onCapture,
  onOpenViewer,
  viewerPending,
}: {
  session: LiveSessionView
  snapshot: SnapshotResponse | null
  capturePending: boolean
  captureError: string | null
  onCapture: () => void
  onOpenViewer: () => void
  viewerPending: boolean
}) {
  const [retried, setRetried] = useState(false)

  if (session.environment === "cloud") {
    return (
      <div className="flex flex-col gap-2">
        <Frame>
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <GlobeIcon className="size-5 text-muted-foreground" aria-hidden />
            <p className="text-xs text-muted-foreground">
              El navegador corre en los servidores de Browserbase. Su visor
              oficial se abre en otra pestaña y caduca a los 10 minutos.
            </p>
          </div>
        </Frame>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] text-muted-foreground">
            Enlace temporal emitido solo para tu cuenta.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={viewerPending}
            onClick={onOpenViewer}
          >
            {viewerPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <ExternalLinkIcon data-icon="inline-start" />
            )}
            Abrir navegador en vivo
          </Button>
        </div>
      </div>
    )
  }

  const image = snapshot && snapshot.ok ? snapshot : null

  return (
    <div className="flex flex-col gap-2">
      <Frame>
        {image ? (
          <Image
            base64={image.base64}
            mediaType={image.mediaType}
            alt="Captura de la ventana del navegador que controla Paradox"
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            {capturePending ? (
              <Loader2Icon className="size-5 animate-spin text-primary" aria-hidden />
            ) : (
              <CameraIcon className="size-5 text-muted-foreground" aria-hidden />
            )}
            <p className="text-xs text-muted-foreground">
              {capturePending
                ? "Pidiendo una captura a tu equipo…"
                : "Sin captura todavía."}
            </p>
          </div>
        )}
      </Frame>

      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] text-muted-foreground">
          {image && snapshot?.ok
            ? `Captura ${relativeTime(snapshot.capturedAt)} · cada ${CAPTURE_POLL_MS / 1000} s`
            : "Capturas periódicas, no vídeo en directo."}
        </p>
        <Button variant="ghost" size="sm" onClick={onCapture} disabled={capturePending}>
          {capturePending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          Capturar ahora
        </Button>
      </div>

      {captureError && !retried && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-2 text-[11px] text-amber-100">
          <span className="min-w-0 line-clamp-2">{captureError}</span>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => {
              setRetried(true)
              onCapture()
            }}
          >
            Reintentar
          </Button>
        </div>
      )}
    </div>
  )
}

export function LiveSessionPanel({ open }: { open: boolean }) {
  const [session, setSession] = useState<LiveSessionView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [slow, setSlow] = useState(false)
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null)
  const [capturePending, setCapturePending] = useState(false)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [capturesPaused, setCapturesPaused] = useState(false)
  const [viewerPending, startViewer] = useTransition()

  const inFlight = useRef<AbortController | null>(null)
  const capturing = useRef(false)

  const load = useCallback(async () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return
    }

    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller

    try {
      const response = await fetch("/api/live/session", {
        signal: controller.signal,
        cache: "no-store",
      })
      if (!response.ok) throw new Error(response.status === 401 ? "session" : "server")

      const body = (await response.json()) as
        | { ok: true; session: LiveSessionView }
        | { ok: false; error: string }
      if (!body.ok) throw new Error(body.error)

      // A slow answer must never overwrite a fresher one on screen.
      setSession((current) =>
        current && Date.parse(body.session.generatedAt) < Date.parse(current.generatedAt)
          ? current
          : body.session
      )
      setError(null)
    } catch (caught) {
      if (controller.signal.aborted) return
      const reason = caught instanceof Error ? caught.message : "server"
      setError(
        reason === "session"
          ? "Tu sesión ha caducado. Recarga la página."
          : "No se pudo consultar la sesión. Se reintentará automáticamente."
      )
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])

  // Read as a primitive so the memoization below is what it looks like: this
  // callback depends on one id, not on the whole session object.
  const taskId = session?.taskId ?? null

  const capture = useCallback(async () => {
    if (!taskId || capturing.current) return

    capturing.current = true
    setCapturePending(true)
    try {
      const response = await fetch("/api/live/session/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId }),
        cache: "no-store",
      })
      const body = (await response.json()) as SnapshotResponse
      setSnapshot(body)
      setCaptureError(body.ok ? null : (body.message ?? "No se pudo capturar la pantalla."))
    } catch {
      setCaptureError("No se pudo pedir la captura a tu equipo.")
    } finally {
      capturing.current = false
      setCapturePending(false)
    }
  }, [taskId])

  // The panel polls the session only while it is open, and stops when the tab
  // is hidden; the first answer also arms the capture loop below.
  useEffect(() => {
    if (!open) return

    const first = window.setTimeout(() => void load(), 0)
    const interval = window.setInterval(() => void load(), SESSION_POLL_MS)
    const guard = window.setTimeout(() => setSlow(true), LOAD_TIMEOUT_MS)

    const onVisibility = () => {
      if (document.visibilityState === "visible") void load()
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      window.clearTimeout(first)
      window.clearTimeout(guard)
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [load, open])

  // Captures only for a local session that is actually active, and only while
  // nobody paused them. Each capture is one job; nothing runs in a hidden tab.
  useEffect(() => {
    if (!open || !session?.canCapture || capturesPaused) return

    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void capture()
    }, CAPTURE_POLL_MS)

    return () => window.clearInterval(interval)
  }, [open, session?.canCapture, capturesPaused, capture])

  useEffect(() => () => inFlight.current?.abort(), [])

  const openViewer = () => {
    if (!taskId) return
    startViewer(async () => {
      try {
        const response = await fetch(
          `/api/live/session/viewer?taskId=${encodeURIComponent(taskId)}`,
          { cache: "no-store" }
        )
        const body = (await response.json()) as ViewerResponse
        if (!body.ok || !body.url) throw new Error(body.error)

        // noopener: the viewer is a third-party page, it must not get a handle
        // on this tab.
        window.open(body.url, "_blank", "noopener,noreferrer")
      } catch {
        setCaptureError(
          "No se pudo abrir el visor. La sesión puede haber terminado; vuelve a intentarlo en unos segundos."
        )
      }
    })
  }

  const environment = session?.environment
    ? sessionEnvironmentLabels[session.environment]
    : null

  return (
    <section aria-labelledby="live-session" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3
          id="live-session"
          className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
        >
          Sesión de automatización
        </h3>
        {session && (
          <span
            className={cn(
              "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium",
              statusTone[session.status]
            )}
          >
            {session.statusLabel}
          </span>
        )}
      </div>

      {loading && !session ? (
        <div className="space-y-2" aria-busy="true">
          <div className="h-24 animate-pulse rounded-xl border border-border/40 bg-card/40" />
          {slow && (
            <p className="text-[11px] text-muted-foreground">
              Todavía sin respuesta del servidor.
              <Button
                variant="ghost"
                size="sm"
                className="ml-1 h-6 px-2 text-[11px]"
                onClick={() => void load()}
              >
                Reintentar
              </Button>
            </p>
          )}
        </div>
      ) : !session || session.status === "none" ? (
        <div className="rounded-xl border border-dashed border-border/60 p-4 text-center">
          <GlobeIcon className="mx-auto size-4 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-sm font-medium">Sin sesión de navegador</p>
          <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
            {session?.pendingEnvironment
              ? "Hay una tarea esperando que elijas dónde ejecutarla (nube o tu equipo). Hasta que respondas, no hay nada que mostrar aquí."
              : "Cuando Godfather abra un navegador para una tarea, verás aquí en qué entorno está trabajando y podrás observarlo."}
          </p>
          {session?.pendingEnvironment && session.conversationId && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              render={<Link href={`/chats/${session.conversationId}`} />}
            >
              Ir a la conversación
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border border-border/50 bg-card/40 p-3">
          <div className="flex flex-col gap-1">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              {environment}
              {session.status === "active" && (
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
              )}
            </p>
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {session.request || "Sin descripción de la tarea."}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {session.startedAt
                ? `Empezó ${relativeTime(session.startedAt)}`
                : null}
              {session.stepCount > 0
                ? ` · ${session.stepCount} paso${session.stepCount === 1 ? "" : "s"} registrado${session.stepCount === 1 ? "" : "s"}`
                : null}
              {session.lastStepLabel && session.lastActivityAt
                ? ` · último: ${session.lastStepLabel} ${relativeTime(session.lastActivityAt)}`
                : null}
            </p>
          </div>

          {session.status === "error" && session.error && (
            <p className="flex items-start gap-1.5 text-[11px] text-destructive">
              <CircleAlertIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span className="line-clamp-3">{session.error}</span>
            </p>
          )}

          {session.status === "disconnected" && (
            <p className="flex items-center gap-1.5 text-[11px] text-amber-200">
              <MonitorOffIcon className="size-3.5 shrink-0" aria-hidden />
              Tu equipo está desconectado; las capturas se reanudan solas cuando
              el agente vuelva.
            </p>
          )}

          {session.status === "paused" && (
            <p className="flex items-center gap-1.5 text-[11px] text-amber-200">
              <PauseIcon className="size-3.5 shrink-0" aria-hidden />
              Pausaste tu Desktop Agent en Ajustes: no puede ejecutar nada hasta
              que lo reanudes.
            </p>
          )}

          <SessionViewport
            session={session}
            snapshot={snapshot}
            capturePending={capturePending}
            captureError={captureError}
            onCapture={() => void capture()}
            onOpenViewer={openViewer}
            viewerPending={viewerPending}
          />

          {session.environment === "local" && (
            <div className="flex items-center justify-between gap-2 border-t border-border/40 pt-2">
              <p className="text-[10px] text-muted-foreground">
                {capturesPaused
                  ? "Capturas detenidas."
                  : "Las capturas paran al cerrar este panel."}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => setCapturesPaused((value) => !value)}
              >
                {capturesPaused ? (
                  <PlayIcon className="size-3" aria-hidden />
                ) : (
                  <PauseIcon className="size-3" aria-hidden />
                )}
                {capturesPaused ? "Reanudar" : "Pausar"}
              </Button>
            </div>
          )}

          {session.status === "finished" && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <TimerIcon className="size-3.5 shrink-0" aria-hidden />
              La sesión terminó. Si fue en la nube, Browserbase conserva la
              grabación desde la conversación de la que salió.
            </p>
          )}

          {error && (
            <p className="text-[11px] text-muted-foreground">{error}</p>
          )}
        </div>
      )}
    </section>
  )
}
