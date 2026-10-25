import { auth } from "@clerk/nextjs/server"
import { and, asc, desc, eq } from "drizzle-orm"

import { db } from "@/db"
import { bots, chatMembers, chats } from "@/db/schema"
import { ORCHESTRATOR_ROLE, sortBotsByVisibility } from "@/lib/agents"

// One of the signed-in user's chats with the bots in it, or null if it isn't theirs
export async function getChat(chatId: string) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const row = await db.query.chats.findFirst({
    where: and(eq(chats.id, chatId), eq(chats.userId, userId)),
    with: {
      // Group members join together, so the bot ID settles the order
      members: {
        orderBy: [asc(chatMembers.joinedAt), asc(chatMembers.botId)],
        with: { bot: true },
      },
    },
  })
  if (!row) return null

  // The hidden orchestrator ("Godfather") is a member of every direct chat, but
  // it is not the agent the person came to talk to, so it goes last: the
  // header, the sidebar and the desktop panel all follow the first member.
  const { members, ...chat } = row
  const ordered = sortBotsByVisibility(members.map((member) => member.bot))

  return ordered.length > 0
    ? { ...chat, bots: ordered }
    : null
}

// A brand-new conversation with Godfather: its own id, its own history. Used
// by the "new chat" entry points (via the server action) so a fresh chat can
// never append to an earlier one.
export async function createAgentChatWithOrchestrator(userId: string) {
  const orchestrator = await db.query.bots.findFirst({
    where: and(eq(bots.userId, userId), eq(bots.role, ORCHESTRATOR_ROLE)),
    columns: { id: true },
  })
  if (!orchestrator) throw new Error("The orchestrator agent is missing")

  const [chat] = await db
    .insert(chats)
    .values({ userId, kind: "direct" })
    .returning({ id: chats.id })

  await db
    .insert(chatMembers)
    .values({ chatId: chat.id, botId: orchestrator.id })

  return chat.id
}

// The Godfather conversation of an already-authenticated user: the most
// recent direct chat whose only member is the orchestrator, created when there
// is none yet. Rendering a page may call this freely — it only inserts when no
// such conversation exists, so a reload never duplicates a row.
export async function findOrCreateAgentHomeChatFor(userId: string) {
  const rows = await db.query.chats.findMany({
    where: and(eq(chats.userId, userId), eq(chats.kind, "direct")),
    orderBy: desc(chats.lastMessageAt),
    with: {
      members: { with: { bot: { columns: { id: true, role: true } } } },
    },
  })

  const existing = rows.find(
    (chat) =>
      chat.members.length === 1 &&
      chat.members[0]?.bot?.role === ORCHESTRATOR_ROLE
  )
  if (existing) return existing.id

  return createAgentChatWithOrchestrator(userId)
}

// Same, with the ownership check for callers that only have the request.
export async function getOrCreateAgentHomeChat() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  return findOrCreateAgentHomeChatFor(userId)
}
