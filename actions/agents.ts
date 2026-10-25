"use server"

import { auth } from "@clerk/nextjs/server"
import { revalidatePath } from "next/cache"

import {
  createAgentChatWithOrchestrator,
  findOrCreateAgentHomeChatFor,
} from "@/queries/chats"
import { ensureDefaultAgents } from "@/queries/bots"

// Opens a conversation with Godfather. The home flow passes nothing and gets
// the conversation already in use (start or reopen); the new-chat button
// passes { fresh: true } and always gets a brand-new conversation, so pressing
// it can never append to an earlier one. Every entry point — the section
// route, the new-conversation button, the panel that asks the agent for a
// change — starts from the same find-or-create in queries/chats.
export async function startAgentChat(options?: { fresh?: boolean }) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  // A brand-new account has no orchestrator until the catalogue is seeded
  await ensureDefaultAgents()

  const chatId = options?.fresh
    ? await createAgentChatWithOrchestrator(userId)
    : await findOrCreateAgentHomeChatFor(userId)

  revalidatePath("/", "layout")

  return chatId
}
