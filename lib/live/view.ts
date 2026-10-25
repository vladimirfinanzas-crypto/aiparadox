// ---------------------------------------------------------------------------
// Live View — the shared vocabulary.
//
// Live View does not own state. Every item it shows is a projection of a row
// that already exists: an automation run (with its steps), a browser/desktop
// execution task, a job queued for the Desktop Agent, or a Godfather tool call
// that produced a resource. This module only translates those rows into one
// shape and decides how they are grouped and ordered; the queries live in
// `queries/live.ts`.
//
// Progress is never estimated: it exists only when the backend reported the
// real numbers (an automation run seeds one step per planned block, so done /
// total is exact).
// ---------------------------------------------------------------------------

export type LiveSource =
  | "godfather"
  | "automation"
  | "workspace"
  | "browser"
  | "desktop"

export type LiveStatus =
  | "attention"
  | "running"
  | "waiting"
  | "queued"
  | "failed"
  | "cancelled"
  | "succeeded"

export type LiveProgress = { done: number; total: number }

export type LiveItem = {
  /** Prefixed with its source, so two tables can never collide. */
  id: string
  source: LiveSource
  title: string
  detail: string
  status: LiveStatus
  /** What the backend calls this state, for people who want the exact word. */
  statusLabel: string
  /** Where the task came from: a chat, a schedule, the desktop agent… */
  origin?: string
  /** The resource it produced or belongs to. */
  href?: string
  hrefLabel?: string
  startedAt?: string
  finishedAt?: string
  progress?: LiveProgress
  result?: string
  error?: string
  updatedAt: string
}

export type LiveDeviceStatus = {
  total: number
  online: number
}

export type LiveFeed = {
  items: LiveItem[]
  counts: {
    active: number
    attention: number
    failed: number
  }
  devices: LiveDeviceStatus
  generatedAt: string
}

export const statusLabels: Record<LiveStatus, string> = {
  attention: "Necesita tu decisión",
  running: "En curso",
  waiting: "Esperando",
  queued: "En cola",
  failed: "Falló",
  cancelled: "Cancelada",
  succeeded: "Terminó",
}

export const sourceLabels: Record<LiveSource, string> = {
  godfather: "Godfather",
  automation: "Automatización",
  workspace: "Workspace",
  browser: "Navegador",
  desktop: "Escritorio",
}

/** Active work: what is moving or about to move. */
const activeStatuses: LiveStatus[] = ["running", "waiting", "queued"]

// Grouping order in the panel: what needs a decision first, then what is
// moving, then what already happened.
const rank: Record<LiveStatus, number> = {
  attention: 0,
  running: 1,
  waiting: 2,
  queued: 3,
  failed: 4,
  cancelled: 5,
  succeeded: 6,
}

export function isActive(status: LiveStatus) {
  return activeStatuses.includes(status)
}

/** Attention first, then active work, then finished items, newest first. */
export function sortLiveItems(items: LiveItem[]): LiveItem[] {
  return [...items].sort((a, b) => {
    const byRank = rank[a.status] - rank[b.status]
    if (byRank !== 0) return byRank
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  })
}

export function countLiveItems(items: LiveItem[]) {
  return {
    active: items.filter((item) => isActive(item.status)).length,
    attention: items.filter((item) => item.status === "attention").length,
    failed: items.filter((item) => item.status === "failed").length,
  }
}

/**
 * Progress as a percentage, only from real numbers. Returns null when the
 * backend has not reported a total yet, so the UI can show a plain state
 * instead of a made-up bar.
 */
export function progressPercent(progress: LiveProgress | undefined): number | null {
  if (!progress || progress.total <= 0) return null
  const ratio = progress.done / progress.total
  return Math.max(0, Math.min(100, Math.round(ratio * 100)))
}

/**
 * The resource a tool call produced, read from what the tool returned. Godfather's
 * tools answer with the path of the row they wrote (`/widgets/abc`,
 * `/workflows/abc`); nothing else is trusted from that text.
 */
export function resourcePathFrom(text: string | null | undefined): string | null {
  if (!text) return null
  const match = text.match(/\/(widgets|workflows)\/[A-Za-z0-9_-]{4,}/)
  return match ? match[0] : null
}

/** "hace 3 min" from an ISO timestamp, stable for a given pair of times. */
export function relativeTime(iso: string, now = Date.now()): string {
  const elapsed = now - Date.parse(iso)
  if (!Number.isFinite(elapsed)) return ""
  if (elapsed < 45_000) return "hace un momento"
  if (elapsed < 3_600_000) return `hace ${Math.max(1, Math.round(elapsed / 60_000))} min`
  if (elapsed < 86_400_000) return `hace ${Math.round(elapsed / 3_600_000)} h`
  return `hace ${Math.round(elapsed / 86_400_000)} d`
}
