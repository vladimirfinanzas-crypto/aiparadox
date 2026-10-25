"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  ActivityIcon,
  MonitorSmartphoneIcon,
  PlugIcon,
  SlidersHorizontalIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"

// Settings is one section with four views. They are links, not client-side tab
// state: each view has its own URL, so it can be bookmarked, reloaded and shared
// without losing where the person was.
const tabs = [
  { href: "/settings", label: "General", icon: SlidersHorizontalIcon },
  {
    href: "/settings/integrations",
    label: "Integrations",
    icon: PlugIcon,
  },
  { href: "/settings/activity", label: "Activity", icon: ActivityIcon },
  {
    href: "/settings/desktop-agent",
    label: "Desktop Agent",
    icon: MonitorSmartphoneIcon,
  },
] as const

export function SettingsTabs() {
  const pathname = usePathname()

  return (
    <nav aria-label="Secciones de Settings" className="w-full">
      <ul className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-1">
        {tabs.map((tab) => {
          const isActive = pathname === tab.href

          return (
            <li key={tab.href} className="shrink-0">
              <Link
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  isActive
                    ? "border-primary/40 bg-primary/10 font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
              >
                <tab.icon className="size-3.5" aria-hidden />
                {tab.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
