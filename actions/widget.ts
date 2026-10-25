"use server"

import { auth } from "@clerk/nextjs/server"
import * as Sentry from "@sentry/nextjs"
import { and, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { db } from "@/db"
import {
  widgets,
  type WidgetInsert,
  widgetInsertSchema,
} from "@/db/schema"
import {
  applyBlockData,
  configFromDocument,
  createDocument,
  readPanelDocument,
} from "@/lib/panels/document"

export async function listWidgets() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  return db
    .select()
    .from(widgets)
    .where(eq(widgets.userId, userId))
    .orderBy(widgets.order, widgets.createdAt)
}

export async function getWidget(id: string) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  return db.query.widgets.findFirst({
    where: and(eq(widgets.id, id), eq(widgets.userId, userId)),
  })
}

export async function createWidget(values: WidgetInsert) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const data = widgetInsertSchema.parse(values)

  const [widget] = await db
    .insert(widgets)
    .values({ ...data, userId })
    .returning()

  revalidatePath("/widgets", "layout")

  Sentry.logger.info("Widget created", {
    "user.id": userId,
    "widget.id": widget.id,
  })

  return widget
}

export async function updateWidget(id: string, values: Partial<WidgetInsert>) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const data = widgetInsertSchema.partial().parse(values)

  const [widget] = await db
    .update(widgets)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(widgets.id, id), eq(widgets.userId, userId)))
    .returning()

  if (!widget) throw new Error("Widget not found")

  revalidatePath("/widgets", "layout")

  Sentry.logger.info("Widget updated", {
    "user.id": userId,
    "widget.id": id,
  })

  return widget
}

// Saves the data of a single block (ticked items, table rows, typed values) so
// two people editing different panels — or the agent rewriting this panel's
// layout at the same time — never overwrite each other's work. The block id is
// the only thing the client controls, and it is resolved against this person's
// own panel.
export async function savePanelBlock(
  widgetId: string,
  blockId: string,
  data: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) return { ok: false, error: "Unauthorized" }

  // A panel's data is small by design; anything larger is a bug or an attack
  if (JSON.stringify(data).length > 64_000) {
    return { ok: false, error: "Demasiados datos para guardar en este bloque." }
  }

  const widget = await db.query.widgets.findFirst({
    where: and(eq(widgets.id, widgetId), eq(widgets.userId, userId)),
    columns: { id: true, config: true },
  })
  if (!widget) return { ok: false, error: "Panel no encontrado." }

  const document = readPanelDocument(widget.config)
  const index = document.blocks.findIndex((block) => block.id === blockId)
  if (index === -1) {
    return { ok: false, error: "Ese bloque ya no existe. Recarga el panel." }
  }

  const block = applyBlockData(document.blocks[index], data)
  if (!block) return { ok: false, error: "Los datos no encajan con el bloque." }

  document.blocks[index] = block

  await db
    .update(widgets)
    .set({
      config: configFromDocument(widget.config, document),
      updatedAt: new Date(),
    })
    .where(and(eq(widgets.id, widgetId), eq(widgets.userId, userId)))

  // The library is refreshed, not this page: revalidating it mid-typing would
  // re-render the panel under the cursor.
  revalidatePath("/widgets")

  return { ok: true }
}

// Renames a panel and edits its one-line purpose. The purpose lives in the
// document, so it travels with the panel when the agent rewrites its blocks.
export async function updatePanelDetails(formData: FormData) {
  const id = formData.get("id") as string
  const name = widgetInsertSchema.shape.name.parse(formData.get("name"))
  const description = String(formData.get("description") ?? "")
    .trim()
    .slice(0, 400)

  const widget = await getWidget(id)
  if (!widget) throw new Error("Widget not found")

  const document = createDocument({
    description,
    blocks: readPanelDocument(widget.config).blocks,
  })

  await db
    .update(widgets)
    .set({
      name,
      config: configFromDocument(widget.config, document),
      updatedAt: new Date(),
    })
    .where(and(eq(widgets.id, id), eq(widgets.userId, widget.userId)))

  revalidatePath("/widgets", "layout")
  revalidatePath(`/widgets/${id}`)
}

// Copies a panel, its layout and everything saved in it. The copy starts as a
// draft so duplicating never publishes anything by accident.
export async function duplicateWidget(formData: FormData) {
  const id = formData.get("id") as string
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const widget = await db.query.widgets.findFirst({
    where: and(eq(widgets.id, id), eq(widgets.userId, userId)),
  })
  if (!widget) throw new Error("Widget not found")

  const [copy] = await db
    .insert(widgets)
    .values({
      userId,
      name: `${widget.name} (copia)`.slice(0, 100),
      type: widget.type,
      config: widget.config,
      order: widget.order,
      isPublished: false,
    })
    .returning({ id: widgets.id })

  revalidatePath("/widgets", "layout")
  redirect(`/widgets/${copy.id}`)
}

export async function publishWidget(formData: FormData) {
  const id = formData.get("id") as string
  await togglePublish(id, true)
}

export async function disableWidget(formData: FormData) {
  const id = formData.get("id") as string
  await togglePublish(id, false)
}

export async function deleteWidget(formData: FormData) {
  const id = formData.get("id") as string
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const [owned] = await db
    .select({ id: widgets.id })
    .from(widgets)
    .where(and(eq(widgets.id, id), eq(widgets.userId, userId)))
  if (!owned) throw new Error("Widget not found")

  await db.delete(widgets).where(and(eq(widgets.id, id), eq(widgets.userId, userId)))

  Sentry.logger.info("Widget deleted", {
    "user.id": userId,
    "widget.id": id,
  })

  revalidatePath("/widgets", "layout")
  redirect("/widgets")
}

async function togglePublish(id: string, isPublished: boolean) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const [widget] = await db
    .update(widgets)
    .set({ isPublished, updatedAt: new Date() })
    .where(and(eq(widgets.id, id), eq(widgets.userId, userId)))
    .returning()

  if (!widget) throw new Error("Widget not found")

  revalidatePath("/widgets", "layout")

  Sentry.logger.info("Widget published/disabled", {
    "user.id": userId,
    "widget.id": id,
    isPublished,
  })

  return widget
}

export async function reorderWidgets(updates: { id: string; order: number }[]) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  await db.transaction(async (tx) => {
    for (const { id, order } of updates) {
      await tx
        .update(widgets)
        .set({ order, updatedAt: new Date() })
        .where(and(eq(widgets.id, id), eq(widgets.userId, userId)))
    }
  })

  revalidatePath("/widgets", "layout")
}