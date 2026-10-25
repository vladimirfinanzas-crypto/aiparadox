import { auth } from "@clerk/nextjs/server"
import { redirect } from "next/navigation"

import { ensureDefaultAgents } from "@/queries/bots"
import { getOrCreateAgentHomeChat } from "@/queries/chats"

// The Godfather section IS the conversation: entering it resolves the
// person's home conversation — created the first time, reopened after, the
// same find-or-create the product has always used, so rendering this page
// never duplicates a row — and hands over to its route. No welcome screen in
// between: the chat, its header, the sidebar history, «Nuevo chat» and the
// input are what the person lands on, ready to type into immediately.
export default async function AgentPage() {
  await auth.protect()

  // A brand-new account gets the default catalogue before the chat resolves,
  // so the orchestrator exists to be the chat's only member.
  await ensureDefaultAgents()

  const chatId = await getOrCreateAgentHomeChat()

  redirect(`/chats/${chatId}`)
}
