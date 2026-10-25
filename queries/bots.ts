import { auth } from "@clerk/nextjs/server"
import { and, asc, desc, eq } from "drizzle-orm"

import { db } from "@/db"
import { bots, chatMembers, chats, type Bot } from "@/db/schema"
import {
  defaultAgents,
  godfather,
  normalizeName,
  orchestratorName,
  ORCHESTRATOR_ROLE,
  sortBotsByVisibility,
} from "@/lib/agents"

// The signed-in user's chats, most recent first, each with the bots in it.
// Fetched in two steps instead of a single nested `with` query: the older
// Drizzle version generates a LATERAL JOIN + json_agg + spurious LIMIT when
// asked to join a `chat` -> `chat_members` -> `bots` chain in one statement,
// which trips the database. Splitting the query keeps the SQL simple and
// still returns exactly the same shape of data.
export async function getChats() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const chatRows = await db.query.chats.findMany({
    where: eq(chats.userId, userId),
    orderBy: desc(chats.lastMessageAt),
  })

  if (chatRows.length === 0) return []

  const chatIds = chatRows.map((chat) => chat.id)

  // Every chat_members row for the user's chats, each already joined with its
  // bot so we can sort the bots per chat without another query.
  const memberRows = await db.query.chatMembers.findMany({
    where: (cm, { inArray }) => inArray(cm.chatId, chatIds),
    with: { bot: true },
    orderBy: [asc(chatMembers.joinedAt), asc(chatMembers.botId)],
  })

  // Group members by chat so we can pick the bots for each chat.
  const membersByChat = new Map<string, typeof memberRows>()
  for (const row of memberRows) {
    const existing = membersByChat.get(row.chatId)
    if (existing) {
      existing.push(row)
    } else {
      membersByChat.set(row.chatId, [row])
    }
  }

  return chatRows.map((chat) => {
    const members = membersByChat.get(chat.id) ?? []
    const bots = sortBotsByVisibility(
      members.map((member) => member.bot).filter((bot): bot is Bot => bot !== null),
    )
    return bots.length > 0 ? { ...chat, bots } : null
  }).filter((chat): chat is NonNullable<typeof chat> => chat !== null)
}

// The signed-in person's agents, oldest first. The first time an account reads
// its agents, the product catalogue is inserted so there is always something to
// talk to. Accounts that have deleted everything keep it that way only until
// they have none left, which is also when the empty state shows.
//
// The hidden orchestrator ("Godfather") is left out: it is never a catalogue
// entry a person picks from, only the agent that fronts the conversations.
export async function getBots() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const rows = await getOrInsertDefaults({
    userId,
    insertDefaults: defaultAgents.length > 0,
  })

  // The hidden orchestrator ("Godfather") is never a catalogue entry a person
  // picks from, so it is left out of every list built on this.
  return rows.filter((bot) => !bot.hidden)
}

// Same insert-once behaviour as `getBots`, but callable from a page that already
// knows it wants the defaults seeded before render.
export async function ensureDefaultAgents() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const rows = await getOrInsertDefaults({ userId, insertDefaults: true })

  return rows.filter((bot) => !bot.hidden)
}

async function getOrInsertDefaults({
  userId,
  insertDefaults,
}: {
  userId: string
  insertDefaults: boolean
}) {
  const existing = await db.query.bots.findMany({
    where: eq(bots.userId, userId),
    orderBy: asc(bots.createdAt),
  })

  // The orchestrator ("Godfather") fronts every conversation, so it must exist
  // on every account — even one that deleted the rest of the catalogue. Seeded
  // on demand for accounts created before it shipped.
  const hasOrchestrator = existing.some(
    (bot) => bot.role === ORCHESTRATOR_ROLE
  )
  if (!hasOrchestrator) {
    // The orchestrator is identified by its role, not by its name, so when the
    // person already has an agent called "Godfather" that name stays theirs and
    // the orchestrator takes a free variant of it. Two agents of one account
    // may never share a name.
    const name = orchestratorName(existing.map((bot) => bot.name))
    await db.insert(bots).values({
      ...godfather,
      name,
      userId,
      instructions: godfather.instructions ?? null,
    })
  }

  if (existing.length > 0) {
    return hasOrchestrator
      ? existing
      : db.query.bots.findMany({
          where: eq(bots.userId, userId),
          orderBy: asc(bots.createdAt),
        })
  }
  if (!insertDefaults) return existing

  // The catalogue is the single source of truth for what a fresh account gets,
  // but a duplicated entry there must never reach the database: two identical
  // agents on one account are indistinguishable to the person and to the router.
  // Keyed on the name alone, because that is what identifies an agent to a
  // person and what the database will not let two agents of one account share.
  const seen = new Set<string>([normalizeName(godfather.name)])
  const uniqueDefaults = defaultAgents.filter((agent) => {
    const key = normalizeName(agent.name)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  await db.insert(bots).values(
    uniqueDefaults.map((agent) => ({
      ...agent,
      userId,
      instructions: agent.instructions ?? null,
    }))
  )

  return db.query.bots.findMany({
    where: eq(bots.userId, userId),
    orderBy: asc(bots.createdAt),
  })
}

// One agent by id, never outside the signed-in person's own
export async function getBot(botId: string) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  // Both conditions in the query, so an id from another account never resolves
  return db.query.bots.findFirst({
    where: and(eq(bots.id, botId), eq(bots.userId, userId)),
  })
}

export type ChatWithBots = Awaited<ReturnType<typeof getChats>>[number]
