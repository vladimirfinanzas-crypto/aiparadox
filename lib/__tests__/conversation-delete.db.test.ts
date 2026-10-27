import { describe, expect, it } from "vitest"

// Integration checks against the real database. Skipped (not faked) when there
// is no DATABASE_URL, so a clean checkout still passes `npm test`.
const hasDatabase = (() => {
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file)
    } catch {
      // A missing file is fine; the value may come from the shell
    }
  }
  return Boolean(process.env.DATABASE_URL)
})()

const USER_A = "__conversation_delete_test_a__"
const USER_B = "__conversation_delete_test_b__"

describe.skipIf(!hasDatabase)(
  "conversation deletion against the real database",
  { timeout: 25_000 },
  () => {
    it("removes one person's chat and its members, and nothing else", async () => {
      const { db } = await import("@/db")
      const { bots, chatMembers, chats, executions, usageEntries } = await import(
        "@/db/schema"
      )
      const { eq, inArray } = await import("drizzle-orm")
      const { deleteChatForUser } = await import("@/queries/chats")

      const everyone = [USER_A, USER_B]
      const clearSlate = async () => {
        await db.delete(chats).where(inArray(chats.userId, everyone))
        await db.delete(bots).where(inArray(bots.userId, everyone))
        await db.delete(executions).where(inArray(executions.userId, everyone))
        await db.delete(usageEntries).where(inArray(usageEntries.userId, everyone))
      }
      await clearSlate()

      // A bot, so the conversation has a membership to cascade
      const [bot] = await db
        .insert(bots)
        .values({ userId: USER_A, name: "Agente de prueba", job: "Probar el borrado" })
        .returning({ id: bots.id })

      const [chat] = await db
        .insert(chats)
        .values({ userId: USER_A, name: "Conversación de prueba" })
        .returning({ id: chats.id })
      await db.insert(chatMembers).values({ chatId: chat.id, botId: bot.id })

      // Two kinds of data around it: an audit row that belongs to this
      // conversation, and billing that belongs to the person
      const ledgerKey = `conversation-delete:${chat.id}`
      await db
        .insert(executions)
        .values({
          userId: USER_A,
          conversationId: chat.id,
          role: "tool",
          prompt: "herramienta prueba",
        })
      await db
        .insert(usageEntries)
        .values({ userId: USER_A, kind: "ai", amount: 1, idempotencyKey: ledgerKey })

      // Somebody else's id matches nothing, and the row survives
      expect(await deleteChatForUser({ userId: USER_B, chatId: chat.id })).toBeNull()
      expect(await db.select().from(chats).where(eq(chats.id, chat.id))).toHaveLength(1)

      // The owner's delete removes the chat — and its memberships follow by
      // the foreign key's cascade
      const deleted = await deleteChatForUser({ userId: USER_A, chatId: chat.id })
      expect(deleted).toEqual({ id: chat.id, kind: "direct" })

      // Persisted: gone for good, so a reload cannot bring it back
      expect(await db.select().from(chats).where(eq(chats.id, chat.id))).toHaveLength(0)
      expect(
        await db.select().from(chatMembers).where(eq(chatMembers.chatId, chat.id))
      ).toHaveLength(0)

      // Unrelated data is untouched: the conversation's audit rows, the
      // billing ledger, and the bot itself
      expect(
        await db.select().from(executions).where(eq(executions.conversationId, chat.id))
      ).toHaveLength(1)
      expect(
        await db.select().from(usageEntries).where(eq(usageEntries.idempotencyKey, ledgerKey))
      ).toHaveLength(1)
      expect(await db.select().from(bots).where(eq(bots.id, bot.id))).toHaveLength(1)

      // Deleting again is not an error; it simply matches nothing
      expect(await deleteChatForUser({ userId: USER_A, chatId: chat.id })).toBeNull()

      await clearSlate()
    })
  }
)
