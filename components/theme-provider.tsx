"use client"

import * as React from "react"

type Theme = "light" | "dark" | "system"

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  resolvedTheme: "light" | "dark"
  themes: Theme[]
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined)

const STORAGE_KEY = "theme"
const DEFAULT_THEME: Theme = "dark"

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "dark"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function getStoredTheme(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored
    }
  } catch {}
  return DEFAULT_THEME
}

function applyTheme(theme: "light" | "dark") {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.classList.remove("light", "dark")
  root.classList.add(theme)
  root.style.colorScheme = theme
}

function ThemeProvider({
  children,
  defaultTheme = DEFAULT_THEME,
  enableSystem = true,
  disableTransitionOnChange = true,
  storageKey = STORAGE_KEY,
}: {
  children: React.ReactNode
  defaultTheme?: Theme
  enableSystem?: boolean
  disableTransitionOnChange?: boolean
  storageKey?: string
}) {
  const [theme, setThemeState] = React.useState<Theme>(defaultTheme)
  const [systemTheme, setSystemTheme] = React.useState<"light" | "dark">("dark")
  const [mounted, setMounted] = React.useState(false)

  // Resolve the actual theme
  const resolvedTheme = React.useMemo(() => {
    if (theme === "system" && enableSystem) {
      return systemTheme
    }
    return theme === "system" ? "dark" : theme
  }, [theme, systemTheme, enableSystem])

  // Set theme
  const setTheme = React.useCallback(
    (newTheme: Theme) => {
      setThemeState(newTheme)
      try {
        localStorage.setItem(storageKey, newTheme)
      } catch {}
    },
    [storageKey]
  )

  // Initialize on mount
  React.useEffect(() => {
    setMounted(true)
    const stored = getStoredTheme()
    setThemeState(stored)

    if (enableSystem) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)")
      setSystemTheme(mq.matches ? "dark" : "light")

      const handler = (e: MediaQueryListEvent) => {
        setSystemTheme(e.matches ? "dark" : "light")
      }
      mq.addEventListener("change", handler)
      return () => mq.removeEventListener("change", handler)
    }
  }, [enableSystem, storageKey])

  // Apply theme to DOM
  React.useEffect(() => {
    if (!mounted) return

    if (disableTransitionOnChange) {
      document.documentElement.setAttribute("data-disable-transitions", "true")
    }

    applyTheme(resolvedTheme)

    if (disableTransitionOnChange) {
      requestAnimationFrame(() => {
        document.documentElement.removeAttribute("data-disable-transitions")
      })
    }
  }, [resolvedTheme, mounted, disableTransitionOnChange])

  // Listen for storage changes
  React.useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === storageKey && e.newValue) {
        if (e.newValue === "light" || e.newValue === "dark" || e.newValue === "system") {
          setThemeState(e.newValue)
        }
      }
    }
    window.addEventListener("storage", handler)
    return () => window.removeEventListener("storage", handler)
  }, [storageKey])

  const value = React.useMemo(
    () => ({
      theme,
      setTheme,
      resolvedTheme,
      themes: enableSystem ? (["light", "dark", "system"] as Theme[]) : (["light", "dark"] as Theme[]),
    }),
    [theme, setTheme, resolvedTheme, enableSystem]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider")
  }
  return context
}

export { ThemeProvider, useTheme }
