"use client"

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { cn } from "@/lib/utils"

const options = [
  { value: "light", label: "Claro", icon: SunIcon },
  { value: "dark", label: "Oscuro", icon: MoonIcon },
  { value: "system", label: "Sistema", icon: MonitorIcon },
] as const

// The theme already had a provider and a class on <html>; what was missing was a
// way to choose it. The choice is stored by the provider (localStorage), so it
// survives reloads and applies to every page.
export function ThemeSwitcher() {
  // No mount guard is needed: the provider starts from the same default on the
  // server and on the client, so the first render matches and the stored choice
  // arrives in the provider's own effect.
  const { theme, setTheme, themes } = useTheme()

  const available = options.filter((option) =>
    (themes as readonly string[]).includes(option.value)
  )

  return (
    <div
      role="group"
      aria-label="Apariencia"
      className="flex items-center gap-1 rounded-full border border-border/50 bg-background/40 p-1"
    >
      {available.map((option) => {
        const active = theme === option.value

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => setTheme(option.value)}
            aria-pressed={active}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <option.icon className="size-3.5" aria-hidden />
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
