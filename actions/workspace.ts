"use server"

import { auth } from "@clerk/nextjs/server"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  createWorkspacePanel,
  deleteWorkspacePanel,
  getWorkspacePanel,
  restoreWorkspaceVersion,
  saveWorkspacePanel,
} from "@/queries/workspace"
import { proposePanel, type PanelTurn } from "@/lib/panels/godfather"
import { createDocument, readPanelDocument, type PanelDocument } from "@/lib/panels/document"

// ---------------------------------------------------------------------------
// Workspace server actions.
//
// These are the only way the browser changes a tool. Every one of them resolves
// the panel through `requireWorkspacePanel`, which filters by the signed-in
// account, so a panel id belonging to somebody else simply does not exist. The
// document that comes back from the browser or from the model is normalized
// again here before it is stored.
// ---------------------------------------------------------------------------

const documentInput = z.object({
  version: z.literal(2),
  description: z.string().max(400).optional(),
  blocks: z.array(z.record(z.string(), z.unknown())).max(24),
})

const historyInput = z
  .array(
    z.object({
      role: z.enum(["user", "assistant"]),
      text: z.string().max(2_000),
    })
  )
  .max(12)
  .optional()

export type WorkspaceProposal = {
  name?: string
  description?: string
  document: PanelDocument
}

export type WorkspaceGodfatherResult = {
  ok: boolean
  message: string
  panelId: string | null
  panelName: string
  proposal: WorkspaceProposal | null
  issues: string[]
}

/**
 * One turn with Godfather about a tool. With a panel id it is a change request
 * for that panel; without one it designs a new tool. Nothing is saved here: the
 * person sees the proposal and decides.
 */
export async function workspaceGodfatherAction(input: {
  panelId?: string | null
  instruction: string
  history?: PanelTurn[]
}): Promise<WorkspaceGodfatherResult> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) {
    return {
      ok: false,
      message: "Tu sesión ha caducado. Vuelve a iniciar sesión para continuar.",
      panelId: null,
      panelName: "",
      proposal: null,
      issues: ["unauthorized"],
    }
  }

  const instruction = input.instruction.trim().slice(0, 2_000)
  if (instruction.length < 3) {
    return {
      ok: false,
      message: "Cuéntame un poco más: qué herramienta necesitas y para qué.",
      panelId: null,
      panelName: "",
      proposal: null,
      issues: ["instruction"],
    }
  }

  const parsedHistory = historyInput.safeParse(input.history)
  const history = parsedHistory.success ? parsedHistory.data : []
  const panelId = input.panelId ?? null

  // The contextual chat always works on the panel the person has open; it never
  // guesses and never falls back to creating another one.
  const panel = panelId ? await getWorkspacePanel(userId, panelId) : null
  if (panelId && !panel) {
    return {
      ok: false,
      message: "Ese panel ya no existe en tu cuenta.",
      panelId: null,
      panelName: "",
      proposal: null,
      issues: ["not_found"],
    }
  }

  const current = panel ? readPanelDocument(panel.config) : undefined

  const result = await proposePanel({
    instruction,
    current,
    name: panel?.name,
    history,
  })

  if (!result.ok || !result.document) {
    return {
      ok: false,
      message: result.message,
      panelId: panel?.id ?? null,
      panelName: panel?.name ?? "",
      proposal: null,
      issues: result.issues,
    }
  }

  return {
    ok: true,
    message: result.message,
    panelId: panel?.id ?? null,
    panelName: panel?.name ?? result.name ?? "Nueva herramienta",
    proposal: {
      name: result.name,
      description: result.document.description,
      document: result.document,
    },
    issues: [],
  }
}

/** Applies a proposal to the panel it was made for, as a new version. */
export async function applyWorkspaceProposalAction(input: {
  panelId: string
  proposal: unknown
}): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) return { ok: false, error: "No autorizado." }

  const parsed = documentInput.safeParse(input.proposal)
  if (!parsed.success) {
    return { ok: false, error: "La propuesta no tiene el formato de un panel." }
  }

  try {
    const document = createDocument({
      description: parsed.data.description,
      blocks: parsed.data.blocks,
    })

    const saved = await saveWorkspacePanel({
      userId,
      id: input.panelId,
      document,
      author: "godfather",
      summary: "Cambio propuesto por Godfather",
    })

    revalidatePath("/widgets")
    revalidatePath(`/widgets/${input.panelId}`)

    return { ok: true, version: saved.version }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "No se pudo guardar el cambio en la herramienta.",
    }
  }
}

/** Turns an accepted proposal into a real tool, owned by this account. */
export async function createWorkspaceFromProposalAction(input: {
  name: string
  proposal: unknown
}): Promise<{ ok: true; panelId: string } | { ok: false; error: string }> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) return { ok: false, error: "No autorizado." }

  const name = input.name.trim().slice(0, 60)
  if (!name) return { ok: false, error: "Ponle un nombre a la herramienta." }

  const parsed = documentInput.safeParse(input.proposal)
  if (!parsed.success) {
    return { ok: false, error: "La propuesta no tiene el formato de un panel." }
  }

  try {
    const document = createDocument({
      description: parsed.data.description,
      blocks: parsed.data.blocks,
    })

    if (document.blocks.length === 0) {
      return { ok: false, error: "La herramienta no tiene ninguna sección." }
    }

    const panel = await createWorkspacePanel({ userId, name, document, author: "godfather" })

    revalidatePath("/widgets")
    return { ok: true, panelId: panel.id }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "No se pudo crear la herramienta.",
    }
  }
}

export async function restoreWorkspaceVersionAction(input: {
  panelId: string
  version: number
}): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) return { ok: false, error: "No autorizado." }

  try {
    const saved = await restoreWorkspaceVersion({
      userId,
      id: input.panelId,
      version: input.version,
    })

    revalidatePath("/widgets")
    revalidatePath(`/widgets/${input.panelId}`)

    return { ok: true, version: saved.version }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "No se pudo volver a esa versión.",
    }
  }
}

export async function deleteWorkspacePanelAction(input: {
  panelId: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) return { ok: false, error: "No autorizado." }

  try {
    await deleteWorkspacePanel(userId, input.panelId)
    revalidatePath("/widgets")
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "No se pudo eliminar.",
    }
  }
}
