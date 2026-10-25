import { auth } from "@clerk/nextjs/server"
import { desc, eq } from "drizzle-orm"

import { db } from "@/db"
import {
  chats,
  executionTasks,
  executions,
  pcJobStatus,
  pcJobs,
  workflows,
} from "@/db/schema"

type PcJobStatus = (typeof pcJobStatus.enumValues)[number]
import { getUsageSummary, type UsageSummary } from "@/queries/dashboard"

export type ActivityEvent = {
  id: string
  at: Date
  kind: "chat" | "automation" | "desktop" | "tool" | "browser"
  title: string
  detail: string
  href?: string
  status: string
}

export type ActivityOverview = {
  events: ActivityEvent[]
  usage: UsageSummary
  jobs: { status: PcJobStatus; count: number }[]
}

// One global history for the dashboard: what was asked, which surface ran it
// and how it ended. It reads only rows owned by the signed-in person.
export async function getActivityOverview(): Promise<ActivityOverview> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const [chatRows, workflowRows, jobRows, executionRows, taskRows, usage] =
    await Promise.all([
    db.query.chats.findMany({
      where: eq(chats.userId, userId),
      orderBy: desc(chats.lastMessageAt),
      limit: 10,
      with: {
        members: { with: { bot: { columns: { name: true } } } },
      },
    }),
    db
      .select({
        id: workflows.id,
        name: workflows.name,
        updatedAt: workflows.updatedAt,
        graph: workflows.graph,
      })
      .from(workflows)
      .where(eq(workflows.userId, userId))
      .orderBy(desc(workflows.updatedAt))
      .limit(10),
    db
      .select()
      .from(pcJobs)
      .where(eq(pcJobs.userId, userId))
      .orderBy(desc(pcJobs.createdAt))
      .limit(10),
    // Every tool call Godfather made, recorded by the execution manager
    db
      .select({
        id: executions.id,
        conversationId: executions.conversationId,
        prompt: executions.prompt,
        status: executions.status,
        error: executions.error,
        result: executions.result,
        createdAt: executions.createdAt,
      })
      .from(executions)
      .where(eq(executions.userId, userId))
      .orderBy(desc(executions.createdAt))
      .limit(10),
    // Browser/desktop tasks: which environment they chose and how they ended
    db
      .select({
        id: executionTasks.id,
        conversationId: executionTasks.conversationId,
        request: executionTasks.request,
        environment: executionTasks.environment,
        status: executionTasks.status,
        error: executionTasks.error,
        events: executionTasks.events,
        createdAt: executionTasks.createdAt,
        decidedAt: executionTasks.decidedAt,
        startedAt: executionTasks.startedAt,
      })
      .from(executionTasks)
      .where(eq(executionTasks.userId, userId))
      .orderBy(desc(executionTasks.createdAt))
      .limit(10),
    getUsageSummary(30),
  ])

  const events: ActivityEvent[] = [
    ...chatRows.map((chat) => ({
      id: `chat-${chat.id}`,
      at: chat.lastMessageAt,
      kind: "chat" as const,
      title: chat.name ?? chat.members[0]?.bot?.name ?? "Conversación",
      detail: chat.lastMessagePreview ?? "Sin mensajes todavía",
      href: `/chats/${chat.id}`,
      status: "activa",
    })),
    ...workflowRows.map((workflow) => ({
      id: `workflow-${workflow.id}`,
      at: workflow.updatedAt,
      kind: "automation" as const,
      title: `Automatización · ${workflow.name}`,
      detail: `${workflow.graph?.nodes.length ?? 0} bloques`,
      href: `/workflows/${workflow.id}`,
      status: "definida",
    })),
    ...jobRows.map((job) => ({
      id: `job-${job.id}`,
      at: job.createdAt,
      kind: "desktop" as const,
      title: `Escritorio · ${job.action.kind}`,
      detail: job.error ?? "Acción enviada al agente local",
      status: job.status,
    })),
    ...taskRows.map((task) => ({
      id: `task-${task.id}`,
      at: task.startedAt ?? task.decidedAt ?? task.createdAt,
      kind: "browser" as const,
      title: `Navegador · ${
        task.environment === "local"
          ? "mi PC"
          : task.environment === "cloud"
            ? "cloud"
            : "esperando entorno"
      }`,
      detail:
        task.error ??
        `${task.request.slice(0, 140)}${
          task.events.length ? ` · ${task.events.length} pasos` : ""
        }`,
      href: task.conversationId ? `/chats/${task.conversationId}` : undefined,
      status: task.status,
    })),
    ...executionRows.map((execution) => {
      const [toolName, ...rest] = execution.prompt.split(" ")
      return {
        id: `exec-${execution.id}`,
        at: execution.createdAt,
        kind: "tool" as const,
        title: `Herramienta · ${toolName ?? "tool"}`,
        detail: execution.error ?? execution.result ?? rest.join(" ") ?? "",
        href: execution.conversationId
          ? `/chats/${execution.conversationId}`
          : undefined,
        status: execution.status,
      }
    }),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 15)

  const jobCounts = new Map<PcJobStatus, number>()
  for (const job of jobRows) {
    jobCounts.set(job.status, (jobCounts.get(job.status) ?? 0) + 1)
  }

  return {
    events,
    usage,
    jobs: [...jobCounts.entries()].map(([status, count]) => ({
      status,
      count,
    })),
  }
}
