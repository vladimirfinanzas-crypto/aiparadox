import { formatDistanceToNowStrict } from "date-fns"
import Link from "next/link"
const BRAND = "Paradox"

import { ChatAvatar } from "@/components/chat-avatar"
import { ChatMenuButton } from "@/components/chat-menu-button"
import { GroupChatAvatar } from "@/components/group-chat-avatar"
import { NewConversationButton } from "@/components/new-conversation-button"
import { ParadoxLogo } from "@/components/paradox-logo"
import { SearchCommand, SearchCommandItem } from "@/components/search-command"
import { SectionNav } from "@/components/section-nav"
import { ToolsPanel } from "@/components/tools-panel"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { UserMenu } from "@/components/user-menu"
import { getChats, type ChatWithBots } from "@/queries/bots"

// A group shows its bots together, a direct chat shows its one bot
function SidebarChatAvatar({ chat }: { chat: ChatWithBots }) {
  return chat.kind === "group" ? (
    <GroupChatAvatar seeds={chat.bots.map((bot) => bot.avatar)} />
  ) : (
    <ChatAvatar seed={chat.bots[0].avatar} />
  )
}

// The dashboard's tools panel: where you go, what you search, who you talk to.
// It holds no space on its own — it docks to the left edge and only slides in
// when the pointer reaches it (see components/tools-panel.tsx).
export async function AppSidebar() {
  const chats = await getChats()

  return (
    <ToolsPanel>
      <Sidebar
        collapsible="none"
        className="h-full w-full border-0 bg-transparent"
      >
        <SidebarHeader>
          <div className="flex items-center justify-between gap-2 px-2 pt-1 pr-10">
            {/* The logo opens the public landing page without ending the
                session; `?landing=1` is what tells the page it is a deliberate
                visit instead of a signed-in visitor who wants the app. */}
            <Link
              href="/?landing=1"
              aria-label="Paradox — ver la página de inicio"
              className="flex shrink-0 cursor-pointer items-center gap-2 font-semibold"
            >
              <ParadoxLogo
                text={BRAND}
                fillClassName="bg-sky-300"
                className="text-xl font-bold"
              />
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <SearchCommand>
                {chats.map((chat) => (
                  <SearchCommandItem
                    key={chat.id}
                    href={`/chats/${chat.id}`}
                    value={chat.id}
                    keywords={[chat.name ?? chat.bots[0].name]}
                  >
                    <SidebarChatAvatar chat={chat} />
                    <span className="truncate">
                      {chat.name ?? chat.bots[0].name}
                    </span>
                  </SearchCommandItem>
                ))}
              </SearchCommand>
            </div>
            <NewConversationButton compact />
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Secciones</SidebarGroupLabel>
            <SidebarGroupContent>
              <SectionNav />
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup className="min-h-0 flex-1">
            <SidebarGroupLabel>
              <span className="min-w-0 flex-1">Conversations</span>
              <span
                aria-hidden
                className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
              >
                {chats.length}
              </span>
            </SidebarGroupLabel>
            <SidebarGroupContent className="min-h-0 flex-1">
              {chats.length === 0 ? (
                <p className="px-2 py-6 text-xs text-muted-foreground">
                  Todavía no hay conversaciones. Empieza una con el botón +
                  junto al buscador.
                </p>
              ) : (
                <SidebarMenu>
                  {chats.map((chat) => (
                    <SidebarMenuItem key={chat.id}>
                      <ChatMenuButton
                        chatId={chat.id}
                        tooltip={chat.name ?? chat.bots[0].name}
                      >
                        <SidebarChatAvatar chat={chat} />
                        <div className="grid flex-1 text-left leading-tight">
                          <div className="flex items-baseline gap-2">
                            <span className="truncate font-medium">
                              {chat.name ?? chat.bots[0].name}
                            </span>
                            <time
                              dateTime={chat.lastMessageAt.toISOString()}
                              className="ml-auto shrink-0 text-xs text-muted-foreground"
                            >
                              {formatDistanceToNowStrict(chat.lastMessageAt)}
                            </time>
                          </div>
                          {chat.lastMessagePreview && (
                            <span className="truncate text-xs text-muted-foreground">
                              {chat.lastMessagePreview}
                            </span>
                          )}
                        </div>
                      </ChatMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            {/* Settings lives in the main navigation now; the footer keeps only
                the account menu, so the same destination is not listed twice. */}
            <SidebarMenuItem>
              <UserMenu />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
    </ToolsPanel>
  )
}
