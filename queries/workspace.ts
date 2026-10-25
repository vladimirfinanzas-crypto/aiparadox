import { and, desc, eq } from "drizzle-orm"

import { db } from "@/db"
import { widgets, widgetVersions, type Widget } from "@/db/schema"
import {
  configFromDocument,
  createDocument,
  documentSummary,
  mergePanelDocuments,
  readPanelDocument,
  structureChanged,
  type PanelDocument,
} from "@/lib/panels/document"

// ---------------------------------------------------------------------------
// Workspace data.
//
// Every function takes the Clerk user id first and puts it in the WHERE clause,
// so a panel id from another account never resolves — the id the browser sends
// is only ever used together with the id of the person signed in.
//
// A panel is one row. Its layout lives in `widgets.config`, its current layout
// version in `widgets.version`, and every structural change is frozen into
// `widget_versions` so it can be inspected and restored. Runtime data (ticks,
// rows, events, typed values) is saved per block by `savePanelBlock` and never
// creates a version.
// ---------------------------------------------------------------------------

export class PanelNotFoundError extends Error {
  constructor() {
    super("Ese panel no existe en tu cuenta.")
    this.name = "PanelNotFoundError"
  }
}

export type WorkspacePanel = {
  id: string
  name: string
  description: string | null
  version: number
  isPublished: boolean
  blocks: number
  summary: string
  updatedAt: Date
  createdAt: Date
}

export type PanelVersionSummary = {
  version: number
  name: string
  description: string | null
  blocks: number
  summary: string
  author: "user" | "godfather" | "migration"
  note: string | null
  createdAt: Date
}

function toSummary(row: {
  id: string
  name: string
  version: number
  isPublished: boolean
  config: unknown
  updatedAt: Date
  createdAt: Date
}): WorkspacePanel {
  const document = readPanelDocument(row.config)
  return {
    id: row.id,
    name: row.name,
    description: document.description ?? null,
    version: row.version,
    isPublished: row.isPublished,
    blocks: document.blocks.length,
    summary: documentSummary(document),
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  }
}

/** The library: this person's panels, most recently changed first. */
export async function listWorkspacePanels(userId: string): Promise<WorkspacePanel[]> {
  const rows = await db
    .select()
    .from(widgets)
    .where(eq(widgets.userId, userId))
    .orderBy(desc(widgets.updatedAt))

  return rows.map(toSummary)
}

/** One panel, only if this account owns it. */
export async function getWorkspacePanel(
  userId: string,
  id: string
): Promise<Widget | null> {
  const row = await db.query.widgets.findFirst({
    where: and(eq(widgets.id, id), eq(widgets.userId, userId)),
  })

  return row ?? null
}

export async function requireWorkspacePanel(userId: string, id: string) {
  const panel = await getWorkspacePanel(userId, id)
  if (!panel) throw new PanelNotFoundError()
  return panel
}

/** Creates a panel and freezes its first layout as version 1. */
export async function createWorkspacePanel({
  userId,
  name,
  document,
  author = "user",
  summary,
}: {
  userId: string
  name: string
  document: PanelDocument
  author?: "user" | "godfather"
  summary?: string
}) {
  const clean = createDocument({
    description: document.description,
    blocks: document.blocks,
  })

  return db.transaction(async (tx) => {
    const [panel] = await tx
      .insert(widgets)
      .values({
        userId,
        name: name.trim().slice(0, 100),
        type: "panel",
        config: { version: 2, description: clean.description, blocks: clean.blocks },
        version: 1,
        isPublished: false,
      })
      .returning()

    if (!panel) throw new Error("No se pudo crear el panel.")

    await tx.insert(widgetVersions).values({
      widgetId: panel.id,
      userId,
      version: 1,
      name: panel.name,
      document: clean,
      author,
      summary: summary ?? "Versión inicial",
    })

    return panel
  })
}

/**
 * Saves a panel's layout. A structural change becomes a new version; a save
 * that only changes the name or the one-line description updates the row
 * without touching the history.
 */
export async function saveWorkspacePanel({
  userId,
  id,
  document,
  author = "user",
  summary,
}: {
  userId: string
  id: string
  document: PanelDocument
  author?: "user" | "godfather"
  summary?: string
}) {
  const current = await requireWorkspacePanel(userId, id)
  const previous = readPanelDocument(current.config)
  const next = createDocument({
    description: document.description,
    blocks: document.blocks,
  })

  if (!structureChanged(previous, next)) {
    return { panel: current, version: current.version, changed: false }
  }

  const version = current.version + 1

  return db.transaction(async (tx) => {
    // A panel created before versioning has no history yet: its current layout
    // becomes the baseline the new version can be compared with.
    await tx
      .insert(widgetVersions)
      .values({
        widgetId: id,
        userId,
        version: current.version,
        name: current.name,
        document: previous,
        author: "migration",
        summary: "Versión inicial",
      })
      .onConflictDoNothing()

    await tx.insert(widgetVersions).values({
      widgetId: id,
      userId,
      version,
      name: current.name,
      document: next,
      author,
      summary: summary?.slice(0, 200) ?? null,
    })

    const [panel] = await tx
      .update(widgets)
      .set({
        config: configFromDocument(current.config, next),
        version,
        updatedAt: new Date(),
      })
      .where(and(eq(widgets.id, id), eq(widgets.userId, userId)))
      .returning()

    if (!panel) throw new PanelNotFoundError()

    return { panel, version, changed: true }
  })
}

/** The layout history, newest first. */
export async function listWorkspaceVersions(
  userId: string,
  id: string
): Promise<PanelVersionSummary[]> {
  const rows = await db
    .select()
    .from(widgetVersions)
    .where(and(eq(widgetVersions.widgetId, id), eq(widgetVersions.userId, userId)))
    .orderBy(desc(widgetVersions.version))
    .limit(30)

  return rows.map((row) => {
    const document = readPanelDocument(row.document)
    return {
      version: row.version,
      name: row.name,
      description: document.description ?? null,
      blocks: document.blocks.length,
      summary: documentSummary(document),
      author: row.author as PanelVersionSummary["author"],
      note: row.summary,
      createdAt: row.createdAt,
    }
  })
}

/**
 * Brings an earlier layout back. The version is read from this person's own
 * history and merged with the current document, so blocks that still exist keep
 * the data already entered in them.
 */
export async function restoreWorkspaceVersion({
  userId,
  id,
  version,
}: {
  userId: string
  id: string
  version: number
}) {
  const current = await requireWorkspacePanel(userId, id)

  const row = await db.query.widgetVersions.findFirst({
    where: and(
      eq(widgetVersions.widgetId, id),
      eq(widgetVersions.userId, userId),
      eq(widgetVersions.version, version)
    ),
  })

  if (!row) throw new PanelNotFoundError()

  const target = readPanelDocument(row.document)
  const merged = mergePanelDocuments(readPanelDocument(current.config), target)

  const saved = await saveWorkspacePanel({
    userId,
    id,
    document: merged,
    author: "user",
    summary: `Vuelta a la versión ${version}`,
  })

  return saved
}

export async function deleteWorkspacePanel(userId: string, id: string) {
  const [row] = await db
    .delete(widgets)
    .where(and(eq(widgets.id, id), eq(widgets.userId, userId)))
    .returning({ id: widgets.id })

  if (!row) throw new PanelNotFoundError()
  return row
}
