import { notFound } from "next/navigation"
import { auth } from "@clerk/nextjs/server"

import { Chat } from "@/components/chat"
import { ChatHeader } from "@/components/chat-header"
import { DesktopPanel, DesktopPanelProvider } from "@/components/desktop-panel"
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { getBot } from "@/queries/bots"
import { getChat } from "@/queries/chats"
import { ORCHESTRATOR_ROLE } from "@/lib/agents"

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ chatId: string }>
  searchParams: Promise<{ q?: string }>
}) {
  await auth.protect()

  const [{ chatId }, { q }] = await Promise.all([params, searchParams])
  const chat = await getChat(chatId)
  if (!chat) notFound()

  // A group has several bots and so no single desktop to show
  if (chat.kind === "group") {
    return (
      <div className="flex h-svh flex-col">
        <ChatHeader chat={chat} />
        <Chat
          chatId={chat.id}
          bots={chat.bots.map(({ id, name, avatar }) => ({ id, name, avatar }))}
          initialPrompt={q}
        />
      </div>
    )
  }

  // The hidden orchestrator ("Godfather") fronts every direct chat, so it is
  // one of the members and the one that answers first.
  const orchestrator = chat.bots.find((bot) => bot.role === ORCHESTRATOR_ROLE)
  const orchestratorView = orchestrator
    ? { id: orchestrator.id, name: orchestrator.name, avatar: orchestrator.avatar }
    : undefined

  // Only the chat agents have a desktop to show. Browser, PC and social agents
  // are backed by their own APIs, so their conversations do not expose a VNC panel.
  const agent = await getBot(chat.bots[0].id)
  if (!agent || agent.kind !== "chat") {
    return (
      <div className="flex h-svh flex-col">
        <ChatHeader chat={chat} />
        <Chat
          chatId={chat.id}
          orchestrator={orchestratorView}
          initialPrompt={q}
        />
      </div>
    )
  }

  return (
    <DesktopPanelProvider key={chat.id} chatId={chat.id}>
      {/* The group sizes itself to its parent, so the viewport height goes here */}
      <div className="h-svh">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel id="chat" minSize="30%">
            <div className="flex h-full flex-col">
              <ChatHeader chat={chat} />
              <Chat
                chatId={chat.id}
                orchestrator={orchestratorView}
                initialPrompt={q}
              />
            </div>
          </ResizablePanel>
          <DesktopPanel name={chat.bots[0].name} />
        </ResizablePanelGroup>
      </div>
    </DesktopPanelProvider>
  )
}
