"use client"

import { useContext } from "react"
import { MonitorIcon } from "lucide-react"

import { ChatAvatar } from "@/components/chat-avatar"
import { DesktopPanelContext } from "@/components/desktop-panel"
import { NewConversationButton } from "@/components/new-conversation-button"
import SpecularButton from "@/components/specular-button"
import { GroupChatAvatar } from "@/components/group-chat-avatar"
import type { ChatWithBots } from "@/queries/bots"

// Rendered in every chat header, but only meaningful when a
// DesktopPanelProvider is above (direct chats with a desktop). Renders
// nothing otherwise so it never crashes outside a provider.
function DesktopButton() {
  const desktopPanel = useContext(DesktopPanelContext)
  if (!desktopPanel) return null

  return (
    <SpecularButton
      size="sm"
      tint="#ffffff"
      tintOpacity={0.06}
      textColor="#f5f5f5"
      lineColor="#ffffff"
      baseColor="#4f46e5"
      intensity={1}
      idleIntensity={0.35}
      followMouse
      proximity={200}
      onClick={desktopPanel.toggle}
      className="ml-auto"
    >
      <MonitorIcon size={16} />
    </SpecularButton>
  )
}

// The conversation's title, plus the way out of it: the new-chat button is
// always visible here, because the sidebar's own + sits behind a panel that
// only appears on hover. Agents are internal to Godfather now: there is no
// dialog here to rename, re-model or re-instruct one.
export function ChatHeader({ chat }: { chat: ChatWithBots }) {
  return (
    <header
      data-slot="chat-header"
      className="flex h-12 shrink-0 items-center gap-2 border-b px-4"
    >
      {chat.kind === "group" ? (
        <h1 className="-ml-2 flex min-w-0 items-center gap-2 px-2">
          <GroupChatAvatar
            seeds={chat.bots.map((bot) => bot.avatar)}
            className="size-6"
          />
          <span className="truncate">{chat.name}</span>
        </h1>
      ) : (
        <h1 className="-ml-2 flex min-w-0 items-center gap-2 px-2">
          <ChatAvatar seed={chat.bots[0].avatar} className="size-6" />
          <span className="truncate">{chat.name ?? chat.bots[0].name}</span>
        </h1>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <NewConversationButton label="Nuevo chat" size="sm" />
        {chat.kind !== "group" && <DesktopButton />}
      </div>
    </header>
  )
}
