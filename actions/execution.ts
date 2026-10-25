"use server"

import { auth as clerkAuth } from "@clerk/nextjs/server"
import * as Sentry from "@sentry/nextjs"

import { browserAvailability } from "@/lib/browser-adapters"
import type { EnvironmentChoice } from "@/lib/execution-router"
import { respondToExecutionEnvironment } from "@/lib/execution-tasks"

// ---------------------------------------------------------------------------
// The click behind the environment card.
//
// The card in the conversation is a real control: it calls this action, which
// validates ownership and status on the server, records the choice on the task
// row and returns the line the chat sends so Godfather resumes exactly there.
// Nothing here trusts the browser beyond the task id and the option id.
// ---------------------------------------------------------------------------

const CHOICES = new Set<EnvironmentChoice>(["local", "cloud", "cancel"])

export type EnvironmentAnswer =
  | {
      status: "selected"
      environment: "local" | "cloud"
      message: string
      /**
       * The message the chat sends to resume the turn. Absent when the task was
       * already resolved, so a double click never starts the work twice.
       */
      resumeText?: string
    }
  | { status: "cancelled"; message: string }
  | { status: "rejected"; message: string }

export async function resolveExecutionEnvironment({
  taskId,
  choice,
}: {
  taskId: string
  choice: EnvironmentChoice
}): Promise<EnvironmentAnswer> {
  const { isAuthenticated, userId } = await clerkAuth()
  if (!isAuthenticated || !userId) {
    return { status: "rejected", message: "Sign in to choose where this runs." }
  }

  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 64) {
    return { status: "rejected", message: "That task does not exist." }
  }
  if (!CHOICES.has(choice)) {
    return { status: "rejected", message: "Unknown option." }
  }

  const availability = await browserAvailability(userId)
  const result = await respondToExecutionEnvironment({
    taskId,
    requesterId: userId,
    choice,
    availability,
  })

  if (result.kind === "rejected") {
    Sentry.logger.warn("Environment choice rejected", {
      "user.id": userId,
      "execution.task_id": taskId,
      "execution.choice": choice,
      "execution.code": result.code,
    })
    return { status: "rejected", message: result.message }
  }

  if (result.kind === "cancelled") {
    Sentry.logger.info("Environment choice cancelled", {
      "user.id": userId,
      "execution.task_id": taskId,
    })
    return {
      status: "cancelled",
      message: "Tarea cancelada. No se abrió ningún navegador.",
    }
  }

  const environment = result.environment
  Sentry.logger.info("Environment chosen", {
    "user.id": userId,
    "execution.task_id": taskId,
    "execution.environment": environment,
    "execution.duplicate": result.duplicate,
  })

  return {
    status: "selected",
    environment,
    message:
      environment === "cloud"
        ? "Navegador cloud (Browserbase) seleccionado."
        : "Navegador de tu PC seleccionado.",
    // A resolved task already ran its resume turn once; answering again would
    // duplicate the work this feature exists to protect.
    ...(result.duplicate
      ? {}
      : {
          resumeText:
            environment === "cloud"
              ? `Entorno elegido para la tarea ${taskId}: navegador cloud (Browserbase). Continúa esa tarea ahora, sin volver a preguntar dónde ejecutarla.`
              : `Entorno elegido para la tarea ${taskId}: navegador de mi PC (Paradox Desktop Agent). Continúa esa tarea ahora, sin volver a preguntar dónde ejecutarla. Si el equipo no responde, dilo y da la ruta para conectarlo.`,
        }),
  }
}
