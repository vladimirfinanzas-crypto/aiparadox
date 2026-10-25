import { auth } from "@clerk/nextjs/server"
import type { Metadata } from "next"

import {
  WorkspaceLibrary,
  type WorkspacePanelView,
} from "@/components/workspace/workspace-library"
import { listWorkspacePanels } from "@/queries/workspace"

export const metadata: Metadata = { title: "Workspace · Paradox" }

// The date label is built on the server and passed as text, so the client tree
// renders exactly the same string (no locale, no time zone, no hydration gap).
function updatedLabel(date: Date) {
  const elapsed = Date.now() - date.getTime()
  if (elapsed < 60_000) return "hace un momento"
  if (elapsed < 3_600_000) return `hace ${Math.floor(elapsed / 60_000)} min`
  if (elapsed < 86_400_000) return `hace ${Math.floor(elapsed / 3_600_000)} h`
  if (elapsed < 7 * 86_400_000) return `hace ${Math.floor(elapsed / 86_400_000)} d`
  return `actualizada el ${new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "short",
  }).format(date)}`
}

export default async function WidgetsPage() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const panels = await listWorkspacePanels(userId)

  const view: WorkspacePanelView[] = panels.map((panel) => ({
    id: panel.id,
    name: panel.name,
    description: panel.description,
    version: panel.version,
    isPublished: panel.isPublished,
    blocks: panel.blocks,
    summary: panel.summary,
    updatedLabel: updatedLabel(panel.updatedAt),
  }))

  return <WorkspaceLibrary panels={view} />
}
