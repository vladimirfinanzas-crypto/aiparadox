"use server"

import { auth as clerkAuth } from "@clerk/nextjs/server"
import * as Sentry from "@sentry/nextjs"
import { auth } from "@trigger.dev/sdk"
import {
  chat,
  defaultStorage,
  type ChatStartSessionParams,
} from "@trigger.dev/sdk/ai"
import { and, eq, inArray, notInArray } from "drizzle-orm"
import { revalidatePath } from "next/cache"

import { db } from "@/db"
import {
  bots,
  chatMembers,
  chats,
  groupChatInsertSchema,
  type GroupChatInsert,
} from "@/db/schema"
import { PAYWALL_ENABLED, type Feature } from "@/lib/billing"
import { getBotDesktopUrl } from "@/lib/daytona"
import type { ChatUIMessage } from "@/lib/sandbox-tools"
import { getUsage } from "@/lib/usage"
import { deleteChatForUser, getChat } from "@/queries/chats"
import type { chatAgent } from "@/trigger/chat"

const startSession = chat.createStartSessionAction<typeof chatAgent>("chat")
const loadStoredTranscript = chat.createLoadTranscriptAction(defaultStorage)

// chatId comes from the browser; only the chat's owner may touch its session
async function assertChatOwner(chatId: string) {
  const chat = await getChat(chatId)
  if (!chat) throw new Error("Chat not found")
}

// The turn itself runs in Trigger.dev, so the web server needs its key before
// anything can start. Without this check the SDK's own error surfaces to the
// browser as "the model did not answer", which sends people looking at the
// wrong thing: no model was ever called.
function assertTriggerConfigured() {
  if (!process.env.TRIGGER_SECRET_KEY?.trim()) {
    throw new Error(
      "Chat unavailable: TRIGGER_SECRET_KEY is not set on the server, so no turn can start. Add it to the deployment's environment (Render → Environment → Environment Variables) and check that the Trigger.dev worker is deployed with the same project."
    )
  }
}

// Billable actions are for plans that include the feature
async function assertFeature(feature: Feature) {
  // Test version: the paywall is off entirely
  if (!PAYWALL_ENABLED) return
  const { has, userId } = await clerkAuth()
  if (!has({ feature })) {
    Sentry.logger.warn("Paid feature blocked: upgrade required", {
      "billing.feature": feature,
      ...(userId && { "user.id": userId }),
    })
    throw new Error("Upgrade required")
  }
}

export async function startChatSession(
  params: ChatStartSessionParams<typeof chatAgent>
) {
  assertTriggerConfigured()
  await assertFeature("bots")
  await assertChatOwner(params.chatId)

  const session = await startSession(params)

  Sentry.logger.info("Chat session started", { "chat.id": params.chatId })

  return session
}

export async function mintChatAccessToken(chatId: string) {
  assertTriggerConfigured()
  // Sending needs a token, so a session started on a paid plan ends with it
  await assertFeature("bots")
  await assertChatOwner(chatId)

  return auth.createPublicToken({
    scopes: { read: { sessions: chatId }, write: { sessions: chatId } },
    expirationTime: "1h",
  })
}

export async function loadTranscript(params: { chatId: string }) {
  await assertChatOwner(params.chatId)

  const transcript = await loadStoredTranscript(params)

  // Stored untyped, but only this agent ever writes it
  return { ...transcript, messages: transcript.messages as ChatUIMessage[] }
}

export async function getDesktopUrl(chatId: string) {
  await assertFeature("sandboxes")

  const chat = await getChat(chatId)
  // Only a direct chat has one desktop to show
  if (!chat || chat.kind !== "direct") throw new Error("Chat not found")

  // Showing the desktop starts the sandbox
  const usage = await getUsage(chat.userId)
  if (!usage || usage.remaining.sandbox <= 0) {
    Sentry.logger.warn("Desktop blocked: usage limit reached", {
      "user.id": chat.userId,
      "chat.id": chatId,
      "usage.kind": "sandbox",
    })
    throw new Error("Usage limit reached")
  }

  // The desktop lives inside the sandbox, so only an agent that has one can
  // show it. Browser, PC and social agents have no desktop of their own.
  const sandboxId = chat.bots[0].sandboxId
  if (!sandboxId) throw new Error("This agent has no desktop of its own.")

  const startedAt = Date.now()
  const url = await getBotDesktopUrl(sandboxId)

  // Waking a stopped sandbox and its desktop is the slow part of opening one
  Sentry.logger.info("Desktop opened", {
    "user.id": chat.userId,
    "chat.id": chatId,
    "bot.id": chat.bots[0].id,
    "sandbox.id": sandboxId,
    "sandbox.start_ms": Date.now() - startedAt,
  })

  return url
}

export async function createGroupChat(values: GroupChatInsert) {
  const { isAuthenticated, userId } = await clerkAuth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const data = groupChatInsertSchema.parse(values)
  const botIds = [...new Set(data.botIds)]

  // The IDs come from the browser; every one must be a bot of this user
  const owned = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.userId, userId), inArray(bots.id, botIds)))
  if (botIds.length < 2 || owned.length !== botIds.length) {
    throw new Error("Bot not found")
  }

  const chat = await db.transaction(async (tx) => {
    const [chat] = await tx
      .insert(chats)
      .values({ userId, kind: "group", name: data.name })
      .returning()

    await tx
      .insert(chatMembers)
      .values(botIds.map((botId) => ({ chatId: chat.id, botId })))

    return chat
  })

  revalidatePath("/", "layout")

  Sentry.logger.info("Group chat created", {
    "user.id": userId,
    "chat.id": chat.id,
    "chat.bot_count": botIds.length,
  })

  return chat
}

export async function updateGroupChat(chatId: string, values: GroupChatInsert) {
  const { isAuthenticated, userId } = await clerkAuth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const data = groupChatInsertSchema.parse(values)
  const botIds = [...new Set(data.botIds)]

  // The IDs come from the browser; every one must be a bot of this user
  const owned = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.userId, userId), inArray(bots.id, botIds)))
  if (botIds.length < 2 || owned.length !== botIds.length) {
    throw new Error("Bot not found")
  }

  const chat = await db.transaction(async (tx) => {
    const [chat] = await tx
      .update(chats)
      .set({ name: data.name })
      .where(
        and(
          eq(chats.id, chatId),
          eq(chats.userId, userId),
          eq(chats.kind, "group")
        )
      )
      .returning()
    if (!chat) throw new Error("Chat not found")

    await tx
      .delete(chatMembers)
      .where(
        and(
          eq(chatMembers.chatId, chatId),
          notInArray(chatMembers.botId, botIds)
        )
      )

    // Bots that stay keep the row they joined with, and so their place
    await tx
      .insert(chatMembers)
      .values(botIds.map((botId) => ({ chatId, botId })))
      .onConflictDoNothing()

    return chat
  })

  revalidatePath("/", "layout")

  Sentry.logger.info("Group chat updated", {
    "user.id": userId,
    "chat.id": chat.id,
    "chat.bot_count": botIds.length,
  })

  return chat
}

export async function deleteGroupChat(chatId: string) {
  const { isAuthenticated, userId } = await clerkAuth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  // Memberships go with the chat; the bots stay
  const [chat] = await db
    .delete(chats)
    .where(
      and(
        eq(chats.id, chatId),
        eq(chats.userId, userId),
        eq(chats.kind, "group")
      )
    )
    .returning({ id: chats.id })
  if (!chat) throw new Error("Chat not found")

  revalidatePath("/", "layout")

  Sentry.logger.info("Group chat deleted", {
    "user.id": userId,
    "chat.id": chat.id,
  })
}

// Deleting a conversation from the sidebar. Answers with a result instead of
// throwing, because the person is waiting on a click: a failure must leave the
// row exactly where it was and say so in words they can act on.
export async function deleteConversationAction(
  chatId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { isAuthenticated, userId } = await clerkAuth()
  if (!isAuthenticated || !userId) {
    return { ok: false, error: "Inicia sesión para eliminar una conversación." }
  }

  // Ids are nanoid-generated server-side; anything else never reaches a query
  const id = typeof chatId === "string" ? chatId.trim() : ""
  if (id.length === 0 || id.length > 64) {
    return { ok: false, error: "Esa conversación no existe." }
  }

  try {
    // The owner lives in the WHERE clause: someone else's chat id matches
    // nothing, and the row itself is the only thing deleted. `chat_members`
    // follows by cascade; audits, usage and the bots are untouched.
    const deleted = await deleteChatForUser({ userId, chatId: id })
    if (!deleted) {
      return { ok: false, error: "Esa conversación no existe o no es tuya." }
    }

    // The sidebar and the search palette are server-rendered from this layout
    revalidatePath("/", "layout")

    Sentry.logger.info("Conversation deleted", {
      "user.id": userId,
      "chat.id": deleted.id,
      "chat.kind": deleted.kind,
    })

    return { ok: true }
  } catch (error) {
    // Nothing was half-removed: the delete is a single statement. Report it
    // and leave the conversation where it is.
    Sentry.logger.error("Conversation delete failed", {
      "user.id": userId,
      "chat.id": id,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      ok: false,
      error: "No se pudo eliminar la conversación. Sigue ahí; inténtalo de nuevo.",
    }
  }
}
