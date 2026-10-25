"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { LayoutDashboard, Settings, Sparkles, Workflow } from "lucide-react"

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

// The four sections of the product. Godfather is the front door; Workspace and
// Automations are where its work lives; Settings holds everything about the
// account — including Integrations and Activity, which are no longer separate
// destinations in the main navigation.
//
// Each is matched by prefix, so a nested route — `/chats/[id]`,
// `/workflows/[id]`, `/widgets/[id]`, `/settings/*` — still lights its section
// up.
const sections = [
  { href: "/chats", label: "Godfather", icon: Sparkles },
  { href: "/widgets", label: "Workspace", icon: LayoutDashboard },
  { href: "/workflows", label: "Automations", icon: Workflow },
  { href: "/settings", label: "Settings", icon: Settings },
] as const

export function SectionNav() {
  const pathname = usePathname()

  return (
    <SidebarMenu aria-label="Secciones">
      {sections.map((section) => {
        const isActive =
          pathname === section.href || pathname.startsWith(`${section.href}/`)

        return (
          <SidebarMenuItem key={section.href}>
            <SidebarMenuButton
              isActive={isActive}
              tooltip={section.label}
              render={<Link href={section.href} />}
            >
              <section.icon aria-hidden />
              <span>{section.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )
      })}
    </SidebarMenu>
  )
}
