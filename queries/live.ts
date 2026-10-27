import { and, desc, eq, gte, inArray, like, or, sql } from "drizzle-orm"

import { db } from "@/db"
import {
  automationRunSteps,
  automationRuns,
  desktopDevices,
  executionTasks,
  executions,
  pcJobs,
  workflows,
} from "@/db/schema"
import { isDeviceOnline, listDevices } from "@/lib/desktop-devices"
import {
  buildLiveSessionView,
  emptyLiveSessionView,
  FINISHED_SESSION_WINDOW_MS,
  type DeviceSummary,
  type LiveSessionView,
} from "@/lib/live/session"
import {
  countLiveItems,
  resourcePathFrom,
  sortLiveItems,
  type LiveFeed,
  type LiveItem,
  type LiveStatus,
} from "@/lib/live/view"

// ---------------------------------------------------------------------------
// Live View reads the rows the backend already writes.
//
// Nothing here keeps its own state and nothing is simulated: automation runs
// come from `automation_runs` (with their seeded steps as real progress),
// browser/desktop tasks from `execution_tasks`, local jobs from `pc_jobs`,
// workspace and automation edits from the tool-call log in `executions`, and
// pending authorizations from `workflows`. Every query filters by the user id
// that the caller resolved from the session.
// ---------------------------------------------------------------------------

const RUN_WINDOW = 12
const TASK_WINDOW = 10
const JOB_WINDOW = 12
const TOOL_WINDOW = 10
const DAY_MS = 86_400_000

const originLabels: Record<string, string> = {
  manual: "Lanzada a mano",
  schedule: "Programada",
  godfather: "Pedida a Godfather",
  api: "Desde la API",
}

const environmentLabels: Record<string, string> = {
  cloud: "en la nube",
  local: "en tu equipo",
  hybrid: "nube y equipo",
}

// Tool calls that produce something worth following. Everything else Godfather
// does (bash, reads, searches) belongs to Activity, not here: it would drown the
// panel in one line per call.
const resourceTools = [
  "panel_create",
  "panel_update",
  "panel_publish",
  "automation_create",
  "automation_update_definition",
] as const

const actionTitles: Record<string, string> = {
  panel_create: "Creó una herramienta",
  panel_update: "Cambió una herramienta",
  panel_publish: "Publicó o despublicó una herramienta",
  automation_create: "Creó una automatización",
  automation_update_definition: "Cambió una automatización",
}

const pcActionLabels: Record<string, string> = {
  screenshot: "captura de pantalla",
  click: "clic",
  move: "movimiento del ratón",
  type: "escritura",
  press: "pulsación de tecla",
  hotkey: "atajo de teclado",
  scroll: "desplazamiento",
  run: "comando",
}

function toolName(prompt: string) {
  return prompt.split(" ", 1)[0] ?? ""
}

function clip(value: string | null | undefined, limit = 160) {
  if (!value) return ""
  const text = value.replace(/\s+/g, " ").trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function runStatus(status: string, error: string | null): { status: LiveStatus; label: string } {
  switch (status) {
    case "queued":
      return { status: "queued", label: "En cola" }
    case "running":
      return { status: "running", label: "Ejecutando" }
    case "blocked":
      return {
        status: "attention",
        label: /aprob/i.test(error ?? "") ? "Espera tu aprobación" : "Bloqueada",
      }
    case "failed":
      return { status: "failed", label: "Falló" }
    case "cancelled":
      return { status: "cancelled", label: "Cancelada" }
    default:
      return { status: "succeeded", label: "Completada" }
  }
}

export async function getLiveFeed(userId: string): Promise<LiveFeed> {
  const since = new Date(Date.now() - DAY_MS)

  const [runRows, approvalRows, taskRows, jobRows, toolRows, devices] =
    await Promise.all([
      db
        .select({
          run: automationRuns,
          workflowName: workflows.name,
          workflowStatus: workflows.status,
        })
        .from(automationRuns)
        .leftJoin(workflows, eq(workflows.id, automationRuns.workflowId))
        .where(eq(automationRuns.userId, userId))
        .orderBy(desc(automationRuns.startedAt))
        .limit(RUN_WINDOW),
      db
        .select({
          id: workflows.id,
          name: workflows.name,
          version: workflows.version,
          updatedAt: workflows.updatedAt,
        })
        .from(workflows)
        .where(
          and(eq(workflows.userId, userId), eq(workflows.status, "pending_approval"))
        )
        .orderBy(desc(workflows.updatedAt))
        .limit(5),
      db
        .select()
        .from(executionTasks)
        .where(eq(executionTasks.userId, userId))
        .orderBy(desc(executionTasks.createdAt))
        .limit(TASK_WINDOW),
      db
        .select()
        .from(pcJobs)
        .where(
          and(
            eq(pcJobs.userId, userId),
            or(
              inArray(pcJobs.status, ["pending", "claimed"]),
              and(eq(pcJobs.status, "failed"), gte(pcJobs.createdAt, since))
            )
          )
        )
        .orderBy(desc(pcJobs.createdAt))
        .limit(JOB_WINDOW),
      db
        .select({
          id: executions.id,
          prompt: executions.prompt,
          status: executions.status,
          error: executions.error,
          result: executions.result,
          conversationId: executions.conversationId,
          startedAt: executions.startedAt,
          completedAt: executions.completedAt,
        })
        .from(executions)
        .where(
          and(
            eq(executions.userId, userId),
            or(...resourceTools.map((name) => like(executions.prompt, `${name} %`)))
          )
        )
        .orderBy(desc(executions.startedAt))
        .limit(TOOL_WINDOW),
      db
        .select({
          id: desktopDevices.id,
          status: desktopDevices.status,
          lastSeenAt: desktopDevices.lastSeenAt,
        })
        .from(desktopDevices)
        .where(eq(desktopDevices.userId, userId)),
    ])

  // Real progress for the runs on screen: the engine seeds one step per planned
  // block when the run starts, so done / total is exact and never estimated.
  const runIds = runRows.map((row) => row.run.id)
  const stepCounts =
    runIds.length > 0
      ? await db
          .select({
            runId: automationRunSteps.runId,
            status: automationRunSteps.status,
            total: sql<number>`count(*)::int`,
          })
          .from(automationRunSteps)
          .where(inArray(automationRunSteps.runId, runIds))
          .groupBy(automationRunSteps.runId, automationRunSteps.status)
      : []

  const progressByRun = new Map<string, { done: number; total: number }>()
  for (const row of stepCounts) {
    const entry = progressByRun.get(row.runId) ?? { done: 0, total: 0 }
    entry.total += row.total
    if (row.status === "done" || row.status === "failed" || row.status === "skipped") {
      entry.done += row.total
    }
    progressByRun.set(row.runId, entry)
  }

  const items: LiveItem[] = []

  for (const { run, workflowName } of runRows) {
    const state = runStatus(run.status, run.error)
    const progress = progressByRun.get(run.id)
    const origin = originLabels[run.origin] ?? run.origin
    const environment = environmentLabels[run.environment] ?? run.environment

    items.push({
      id: `run-${run.id}`,
      source: "automation",
      title: workflowName ?? "Automatización",
      detail: `${origin} · ${environment}`,
      status: state.status,
      statusLabel: state.label,
      origin: run.origin,
      href: `/workflows/${run.workflowId}`,
      hrefLabel: "Abrir automatización",
      startedAt: run.startedAt.toISOString(),
      ...(run.finishedAt ? { finishedAt: run.finishedAt.toISOString() } : {}),
      ...(state.status === "running" && progress && progress.total > 0
        ? { progress }
        : {}),
      ...(run.error ? { error: clip(run.error) } : {}),
      updatedAt: (run.finishedAt ?? run.startedAt).toISOString(),
    })
  }

  for (const workflow of approvalRows) {
    items.push({
      id: `approval-${workflow.id}`,
      source: "automation",
      title: `${workflow.name} espera tu aprobación`,
      detail: `Versión ${workflow.version} revisada por Godfather. Nada se ejecuta hasta que la autorices.`,
      status: "attention",
      statusLabel: "Espera tu aprobación",
      href: `/workflows/${workflow.id}`,
      hrefLabel: "Revisar y autorizar",
      updatedAt: workflow.updatedAt.toISOString(),
    })
  }

  for (const task of taskRows) {
    const state: { status: LiveStatus; label: string } =
      task.status === "awaiting_execution_environment"
        ? { status: "attention", label: "Espera tu decisión" }
        : task.status === "running"
          ? { status: "running", label: "Ejecutando" }
          : task.status === "queued"
            ? { status: "queued", label: "En cola" }
            : task.status === "failed"
              ? { status: "failed", label: "Falló" }
              : task.status === "cancelled"
                ? { status: "cancelled", label: "Cancelada" }
                : { status: "succeeded", label: "Completada" }

    const environment =
      task.environment === "local"
        ? "tu equipo"
        : task.environment === "cloud"
          ? "la nube"
          : "sin entorno elegido"

    items.push({
      id: `task-${task.id}`,
      source: task.environment === "local" ? "desktop" : "browser",
      title:
        task.status === "awaiting_execution_environment"
          ? "Elige dónde ejecutar la tarea"
          : `Tarea en ${environment}`,
      detail: clip(task.request) || "Sin descripción",
      status: state.status,
      statusLabel: state.label,
      ...(task.events.length > 0
        ? { result: `${task.events.length} paso${task.events.length === 1 ? "" : "s"} registrados` }
        : {}),
      ...(task.conversationId
        ? { href: `/chats/${task.conversationId}`, hrefLabel: "Abrir conversación" }
        : {}),
      startedAt: (task.startedAt ?? task.createdAt).toISOString(),
      ...(task.completedAt ? { finishedAt: task.completedAt.toISOString() } : {}),
      ...(task.error ? { error: clip(task.error) } : {}),
      updatedAt: (task.completedAt ?? task.startedAt ?? task.createdAt).toISOString(),
    })
  }

  for (const job of jobRows) {
    const state: { status: LiveStatus; label: string } =
      job.status === "pending"
        ? { status: "waiting", label: "Esperando al Desktop Agent" }
        : job.status === "claimed"
          ? { status: "running", label: "Ejecutando en tu equipo" }
          : { status: "failed", label: "Falló" }

    items.push({
      id: `job-${job.id}`,
      source: "desktop",
      title: `Escritorio · ${pcActionLabels[job.action.kind] ?? job.action.kind}`,
      detail:
        job.status === "pending"
          ? "En cola para tu equipo; el agente la recoge en su siguiente consulta."
          : "El agente local la tomó y está ejecutándola.",
      status: state.status,
      statusLabel: state.label,
      href: "/settings/desktop-agent",
      hrefLabel: "Ver agentes",
      startedAt: job.createdAt.toISOString(),
      ...(job.completedAt ? { finishedAt: job.completedAt.toISOString() } : {}),
      ...(job.error ? { error: clip(job.error) } : {}),
      updatedAt: (job.completedAt ?? job.claimedAt ?? job.createdAt).toISOString(),
    })
  }

  for (const row of toolRows) {
    const name = toolName(row.prompt)
    const path = resourcePathFrom(row.result)
    const state: { status: LiveStatus; label: string } =
      row.status === "running"
        ? { status: "running", label: "Trabajando" }
        : row.status === "failed"
          ? { status: "failed", label: "Falló" }
          : { status: "succeeded", label: "Guardado" }

    items.push({
      id: `tool-${row.id}`,
      source: name.startsWith("panel_") ? "workspace" : "godfather",
      title: actionTitles[name] ?? name,
      detail: path
        ? `Guardado en ${path}`
        : state.status === "failed"
          ? "La operación no se completó."
          : "Operación de Godfather sobre tu espacio de trabajo.",
      status: state.status,
      statusLabel: state.label,
      ...(path ? { href: path, hrefLabel: "Abrir resultado" } : {}),
      startedAt: row.startedAt.toISOString(),
      ...(row.completedAt ? { finishedAt: row.completedAt.toISOString() } : {}),
      ...(row.error ? { error: clip(row.error) } : {}),
      updatedAt: (row.completedAt ?? row.startedAt).toISOString(),
    })
  }

  const sorted = sortLiveItems(items).slice(0, 30)
  const online = devices.filter((device) => isDeviceOnline(device)).length

  return {
    items: sorted,
    counts: countLiveItems(sorted),
    devices: { total: devices.length, online },
    generatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// The session behind the feed: is browser work happening right now, and where?
// ---------------------------------------------------------------------------

/** How many computers this person has, and which of them are reachable. */
async function deviceSummary(userId: string): Promise<DeviceSummary> {
  const devices = await listDevices(userId)
  return {
    total: devices.length,
    online: devices.filter((device) => isDeviceOnline(device)).length,
    paused: devices.some((device) => device.status === "paused"),
  }
}

/**
 * The one session worth showing: the newest browser task that is still working,
 * or the last one if it ended recently.
 *
 * Scoped by user id in the query itself, so a task id from another account never
 * reaches the panel. A task that has not chosen cloud or local yet is not a
 * session — it is a question, and the panel says so instead of guessing an
 * environment.
 */
export async function getLiveSession(userId: string): Promise<LiveSessionView> {
  const device = await deviceSummary(userId)

  // 1. Active work first: queued or running, with an environment already chosen.
  const [active] = await db
    .select()
    .from(executionTasks)
    .where(
      and(
        eq(executionTasks.userId, userId),
        inArray(executionTasks.status, ["queued", "running"]),
        sql`${executionTasks.environment} is not null`
      )
    )
    .orderBy(desc(executionTasks.createdAt))
    .limit(1)

  if (active) return buildLiveSessionView({ task: active, device })

  // 2. Otherwise the most recent finished session, but only for a short window:
  // yesterday's browser is history, not a live view.
  const [finished] = await db
    .select()
    .from(executionTasks)
    .where(
      and(
        eq(executionTasks.userId, userId),
        sql`${executionTasks.environment} is not null`,
        gte(executionTasks.completedAt, new Date(Date.now() - FINISHED_SESSION_WINDOW_MS))
      )
    )
    .orderBy(desc(executionTasks.completedAt))
    .limit(1)

  if (finished) return buildLiveSessionView({ task: finished, device })

  // 3. Nothing running: is a question still on screen? That is not a session,
  // but the panel should say why there is no viewport instead of showing nothing.
  const [pending] = await db
    .select({ id: executionTasks.id })
    .from(executionTasks)
    .where(
      and(
        eq(executionTasks.userId, userId),
        eq(executionTasks.status, "awaiting_execution_environment"),
        gte(
          executionTasks.createdAt,
          new Date(Date.now() - FINISHED_SESSION_WINDOW_MS)
        )
      )
    )
    .orderBy(desc(executionTasks.createdAt))
    .limit(1)

  return emptyLiveSessionView(device, Boolean(pending))
}
