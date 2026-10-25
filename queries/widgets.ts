import { auth } from "@clerk/nextjs/server"
import { and, asc, eq } from "drizzle-orm"

import { db } from "@/db"
import { widgets } from "@/db/schema"

export async function getWidgets() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  return db
    .select()
    .from(widgets)
    .where(eq(widgets.userId, userId))
    .orderBy(asc(widgets.order), asc(widgets.createdAt))
}

export async function getPublishedWidgets() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  return db
    .select()
    .from(widgets)
    .where(and(eq(widgets.userId, userId), eq(widgets.isPublished, true)))
    .orderBy(asc(widgets.order), asc(widgets.createdAt))
}

export async function getWidget(id: string) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  return db.query.widgets.findFirst({
    where: and(eq(widgets.id, id), eq(widgets.userId, userId)),
  })
}