import { auth } from "@clerk/nextjs/server"

import { AppSidebar } from "@/components/app-sidebar"
import { LiveView } from "@/components/live/live-view"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // The sidebar loads the user's chats, so signed-out visitors go to sign-in first
  await auth.protect()

  // The tools panel starts away and comes in when the pointer reaches the left
  // edge (components/tools-panel.tsx). Its position is not remembered from one
  // page to the next: a hover would otherwise leave the panel open on the next
  // load, undoing the behaviour it is there for.
  return (
    <SidebarProvider defaultOpen={false}>
      <AppSidebar />
      <SidebarInset>{children}</SidebarInset>
      {/* The corner panel: what is running right now, from the backend itself */}
      <LiveView />
    </SidebarProvider>
  )
}
