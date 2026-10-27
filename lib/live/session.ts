import type { ExecutionTask } from "@/db/schema"

// ---------------------------------------------------------------------------
// Live View — the session section.
//
// The task feed above it answers "what work exists". This answers a different
// question: *where is the work happening right now, and can I look at it?*
//
// The honest constraint that shapes everything here: browser sessions live in
// the Trigger.dev process that opened them (`lib/browser-sessions.ts` keeps them
// in memory), so an HTTP route in the web app cannot reach into one and take a
// picture. Each environment therefore gets the mechanism it actually has:
//
//   cloud   Browserbase's own live view (`sessions.debug` returns an expiring
//           debugger URL). We never build our own video: the provider owns the
//           stream and sells the viewer.
//   local   The Desktop Agent answers a screenshot job over the existing queue.
//           That is periodic captures, not video, and the panel says so.
//
// No browser session means no viewport at all — the panel shows the state, not
// a placeholder pretending to be a feed.
// ---------------------------------------------------------------------------

/** The six states a session can be in, plus "ended" for the last one. */
export type LiveSessionStatus =
  | "none"
  | "connecting"
  | "active"
  | "paused"
  | "disconnected"
  | "finished"
  | "error"

export type LiveSessionEnvironment = "cloud" | "local"

/** What the panel knows about this person's computers, for one session. */
export type DeviceSummary = {
  total: number
  /** Reachable right now (status online and a recent heartbeat). */
  online: number
  /** At least one device the person paused on purpose. */
  paused: boolean
}

export type LiveSessionStep = {
  at: string
  kind: string
  /** The tool name, for a browser step. */
  tool?: string
  detail?: string
  durationMs?: number
}

export type LiveSessionView = {
  /** False when there is no session at all: the panel must not draw a viewport. */
  hasSession: boolean
  /** True when a task is waiting for the person to pick cloud or local. */
  pendingEnvironment: boolean
  taskId: string | null
  environment: LiveSessionEnvironment | null
  status: LiveSessionStatus
  statusLabel: string
  /** What the person asked for, in their words. */
  request: string
  startedAt: string | null
  completedAt: string | null
  /** Last time the backend recorded anything for this session. */
  lastActivityAt: string | null
  lastStepLabel: string | null
  stepCount: number
  error: string | null
  conversationId: string | null
  device: DeviceSummary | null
  /**
   * A live viewer exists for this session (cloud only, while Browserbase still
   * has it). Asked for separately, so a poll never mints links nobody opens.
   */
  canViewLive: boolean
  /** The agent can be asked for a screenshot (local only, device reachable). */
  canCapture: boolean
  generatedAt: string
}

export const sessionStatusLabels: Record<LiveSessionStatus, string> = {
  none: "Sin sesión",
  connecting: "Conectando",
  active: "Activo",
  paused: "Pausado",
  disconnected: "Desconectado",
  finished: "Finalizada",
  error: "Error",
}

export const sessionEnvironmentLabels: Record<LiveSessionEnvironment, string> = {
  cloud: "Navegador en la nube · Browserbase",
  local: "Navegador en tu equipo · Desktop Agent",
}

/**
 * A finished session is only worth showing for a while. After that the panel is
 * back to "Sin sesión" instead of resurrecting yesterday's browser.
 */
export const FINISHED_SESSION_WINDOW_MS = 30 * 60_000

/**
 * Which state the panel is in.
 *
 * "Disconnected" is specific: a *local* session whose computer went quiet. A
 * cloud session has no computer to go quiet, so it stays active until the task
 * ends — showing a warning there would be noise, not information.
 */
export function sessionStatus(input: {
  environment: LiveSessionEnvironment
  taskStatus: string
  device: DeviceSummary | null
}): LiveSessionStatus {
  switch (input.taskStatus) {
    case "queued":
      return "connecting"
    case "failed":
      return "error"
    case "completed":
    case "cancelled":
      return "finished"
    case "running":
      if (input.environment === "cloud") return "active"
      if (input.device?.paused) return "paused"
      if (!input.device || input.device.online === 0) return "disconnected"
      return "active"
    default:
      // "awaiting_execution_environment" never reaches here: a task without an
      // environment has no session to show.
      return "connecting"
  }
}

/** The tool name as a person would read it, from the step event the task wrote. */
const stepToolLabels: Record<string, string> = {
  browser_navigate: "abrió una página",
  browser_read: "leyó la página",
  browser_click: "hizo clic",
  browser_type: "escribió",
  browser_press: "pulsó una tecla",
  browser_back: "retrocedió",
  browser_tabs: "miró las pestañas",
  browser_select_tab: "cambió de pestaña",
  browser_screenshot: "hizo una captura",
  session_opened: "abrió el navegador",
}

/** "abrió una página" / "falló browser_click", from the last event recorded. */
export function lastStepLabel(events: LiveSessionStep[]): string | null {
  const latest = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  if (!latest) return null
  if (latest.kind === "session_opened") return stepToolLabels.session_opened
  const verb = stepToolLabels[latest.tool ?? ""] ?? latest.tool ?? null
  if (!verb) return null
  return latest.kind === "error" ? `falló ${verb}` : verb
}

/** Only browser work can be watched: a desktop job with no session has nothing. */
export function canWatchSession(
  environment: LiveSessionEnvironment | null,
  task: Pick<ExecutionTask, "browserSessionId" | "status">,
  device: DeviceSummary | null
): { canViewLive: boolean; canCapture: boolean } {
  const running = task.status === "running" || task.status === "queued"

  return {
    canViewLive:
      environment === "cloud" && running && Boolean(task.browserSessionId),
    canCapture:
      environment === "local" && running && (device?.online ?? 0) > 0,
  }
}

/**
 * The panel's whole payload for one task, from rows that already exist.
 *
 * `events` is the task's own audit trail, capped here so a long session does
 * not ship its full history on every poll.
 */
export function buildLiveSessionView({
  task,
  device,
  now = Date.now(),
}: {
  task: Pick<
    ExecutionTask,
    | "id"
    | "environment"
    | "status"
    | "request"
    | "error"
    | "events"
    | "conversationId"
    | "browserSessionId"
    | "createdAt"
    | "startedAt"
    | "completedAt"
  >
  device: DeviceSummary | null
  now?: number
}): LiveSessionView {
  const environment =
    task.environment === "cloud" || task.environment === "local"
      ? task.environment
      : null

  const status = environment
    ? sessionStatus({ environment, taskStatus: task.status, device })
    : "none"

  const events = (task.events ?? []).slice(-20)
  const lastEvent = events[events.length - 1]
  const { canViewLive, canCapture } = canWatchSession(environment, task, device)

  return {
    hasSession: Boolean(environment),
    pendingEnvironment: !environment,
    taskId: task.id,
    environment,
    status,
    statusLabel: sessionStatusLabels[status],
    request: task.request.slice(0, 160),
    startedAt: (task.startedAt ?? task.createdAt).toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
    lastActivityAt:
      lastEvent?.at ?? task.completedAt?.toISOString() ?? null,
    lastStepLabel: lastStepLabel(events),
    stepCount: events.filter((entry) => entry.kind === "step").length,
    error: task.error ? task.error.slice(0, 300) : null,
    conversationId: task.conversationId,
    device,
    canViewLive,
    canCapture,
    generatedAt: new Date(now).toISOString(),
  }
}

/** The empty state, so the panel renders one shape and never a null check. */
export function emptyLiveSessionView(
  device: DeviceSummary | null,
  pendingEnvironment = false,
  now = Date.now()
): LiveSessionView {
  return {
    hasSession: false,
    pendingEnvironment,
    taskId: null,
    environment: null,
    status: "none",
    statusLabel: sessionStatusLabels.none,
    request: "",
    startedAt: null,
    completedAt: null,
    lastActivityAt: null,
    lastStepLabel: null,
    stepCount: 0,
    error: null,
    conversationId: null,
    device,
    canViewLive: false,
    canCapture: false,
    generatedAt: new Date(now).toISOString(),
  }
}

/** A snapshot older than the one on screen is discarded by the panel. */
export function isNewerSessionView(
  next: Pick<LiveSessionView, "generatedAt">,
  current: Pick<LiveSessionView, "generatedAt">
): boolean {
  return Date.parse(next.generatedAt) >= Date.parse(current.generatedAt)
}
