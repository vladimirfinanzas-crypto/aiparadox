"use client"

import * as React from "react"
import { MenuIcon, XIcon } from "lucide-react"

import { useSidebar } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

/**
 * The dashboard's tools panel: navigation, search and conversations.
 *
 * It docks over the work area instead of holding a column of its own, so the
 * page never reflows:
 *
 *   - the pointer reaches the left edge  → the panel slides in;
 *   - the pointer leaves it              → it slides away again;
 *   - a menu opened from the panel, or keyboard focus inside it, keeps it open;
 *   - Ctrl/⌘+B still toggles it, and Escape closes it.
 *
 * The pointer is followed on the whole document rather than only inside the
 * panel: a panel that slides under a still pointer does not receive
 * `pointerenter` in every browser, and then it would never learn that the
 * pointer left either.
 *
 * On touch screens there is no hover to read, so the same panel becomes an
 * overlay opened from the button in the corner.
 */

// Popups that render in a portal, outside the panel. Moving the pointer into
// one of them is not "leaving the panel": the menu the person just opened has
// to stay usable.
const PORTAL_SELECTOR = [
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="select-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="dialog-content"]',
  '[data-slot="tooltip-content"]',
  '[role="menu"]',
  '[role="dialog"]',
  '[role="listbox"]',
].join(",")

// The strip along the left edge that brings the panel back.
const EDGE_WIDTH_PX = 14

// How long the panel waits before sliding away: long enough to cross the gap
// between the panel and a menu, short enough to feel immediate.
const CLOSE_DELAY_MS = 220

export function ToolsPanel({ children }: { children: React.ReactNode }) {
  const { open, setOpen, openMobile, setOpenMobile, isMobile } = useSidebar()

  const visible = isMobile ? openMobile : open
  const setVisible = React.useCallback(
    (next: boolean) => {
      if (isMobile) setOpenMobile(next)
      else setOpen(next)
    },
    [isMobile, setOpen, setOpenMobile]
  )

  // Latest state for the document listeners, which outlive renders. Synced in an
  // effect rather than during render, so React can drop a render safely.
  const visibleRef = React.useRef(visible)
  React.useEffect(() => {
    visibleRef.current = visible
  }, [visible])

  // Whether the pointer has visited the dock since it opened. A panel opened
  // from the keyboard stays until the pointer has been in and left the zone;
  // one the pointer opened itself closes as soon as it leaves.
  const visitedRef = React.useRef(false)
  const closeTimer = React.useRef<number | null>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const lastTriggerRef = React.useRef<HTMLElement | null>(null)

  const cancelClose = React.useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  const reveal = React.useCallback(() => {
    cancelClose()
    if (!visibleRef.current) setVisible(true)
  }, [cancelClose, setVisible])

  const hide = React.useCallback(() => {
    cancelClose()
    setVisible(false)
  }, [cancelClose, setVisible])

  React.useEffect(() => {
    if (isMobile) return

    const panel = panelRef.current
    if (!panel) return

    const scheduleClose = () => {
      cancelClose()
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null
        // A menu or a dialog on top of the panel is still in use
        if (document.querySelector(PORTAL_SELECTOR)) return
        // Keyboard users keep the panel while focus is inside it
        if (panel.contains(document.activeElement)) return
        setVisible(false)
      }, CLOSE_DELAY_MS)
    }

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return

      // The dock's zone: the open panel, or the edge strip while it is away.
      const zoneRight = visibleRef.current
        ? Math.max(panel.getBoundingClientRect().right, EDGE_WIDTH_PX)
        : EDGE_WIDTH_PX

      if (event.clientX >= 0 && event.clientX <= zoneRight) {
        visitedRef.current = true
        reveal()
        return
      }

      if (visibleRef.current && visitedRef.current) scheduleClose()
    }

    // The mouse leaving the window is also leaving the panel.
    const onPointerOut = (event: PointerEvent) => {
      if (event.pointerType === "touch") return
      if (event.relatedTarget === null && visibleRef.current) scheduleClose()
    }

    document.addEventListener("pointermove", onPointerMove, { passive: true })
    document.addEventListener("pointerout", onPointerOut)

    return () => {
      cancelClose()
      document.removeEventListener("pointermove", onPointerMove)
      document.removeEventListener("pointerout", onPointerOut)
    }
  }, [cancelClose, isMobile, reveal, setVisible])

  // Escape closes the panel, like any other floating surface.
  React.useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setVisible(false)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [visible, setVisible])

  // A fresh visit is needed every time the panel comes back.
  React.useEffect(() => {
    if (!visible) visitedRef.current = false
  }, [visible])

  const openFromButton = (event: React.MouseEvent<HTMLButtonElement>) => {
    lastTriggerRef.current = event.currentTarget
    reveal()
  }

  // Where focus goes back to when the panel is dismissed from the inside.
  const closeFromPanel = () => {
    hide()
    lastTriggerRef.current?.focus()
  }

  return (
    <>
      {/* Touch screens: no hover to read, so a button opens the panel */}
      <button
        type="button"
        aria-label="Open tools panel"
        aria-expanded={visible}
        onClick={openFromButton}
        className={cn(
          "fixed top-3 left-3 z-40 grid size-9 place-items-center rounded-lg border border-border/60 bg-background/80 text-foreground shadow-sm backdrop-blur-md md:hidden",
          visible && "pointer-events-none opacity-0"
        )}
      >
        <MenuIcon className="size-4" aria-hidden />
      </button>

      {/* Desktop: the strip that brings the panel back */}
      {!isMobile && (
        <button
          type="button"
          aria-label="Show tools panel"
          aria-expanded={visible}
          data-slot="tools-panel-zone"
          onPointerEnter={reveal}
          onFocus={reveal}
          onClick={reveal}
          className={cn(
            "group/hover-zone fixed inset-y-0 left-0 z-30 hidden w-3.5 cursor-e-resize md:block",
            // While the panel is out, the strip must not sit in front of it.
            visible && "pointer-events-none",
            "before:absolute before:inset-y-0 before:left-0 before:w-full before:bg-gradient-to-r before:from-primary/30 before:to-transparent before:opacity-0 before:transition-opacity before:duration-200",
            "hover:before:opacity-100 focus-visible:outline-none focus-visible:before:opacity-100"
          )}
        >
          {/* The handle that hints a panel lives here, shown only while away */}
          <span
            aria-hidden
            className={cn(
              "absolute top-1/2 left-0 h-16 w-1 -translate-y-1/2 rounded-r-full bg-border transition-all duration-200",
              "group-hover/hover-zone:h-full group-hover/hover-zone:bg-primary/60",
              visible ? "opacity-0" : "opacity-100"
            )}
          />
        </button>
      )}

      {/* Backdrop for the touch overlay */}
      {visible && (
        <div
          aria-hidden
          onClick={() => setVisible(false)}
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
        />
      )}

      <div
        ref={panelRef}
        data-slot="tools-panel"
        data-open={visible}
        aria-hidden={!visible}
        // Keeps the off-screen panel out of the tab order and out of reach of
        // assistive tech while it is away.
        inert={!visible}
        className={cn(
          "fixed inset-y-0 left-0 z-20 flex w-64 flex-col border-r border-border/60 bg-sidebar text-sidebar-foreground",
          "transition-transform duration-200 ease-out will-change-transform",
          visible ? "translate-x-0" : "-translate-x-full",
          // Above the backdrop on touch screens, below it on desktop
          "max-md:z-50 max-md:w-72 max-md:shadow-2xl",
          "shadow-2xl shadow-black/30"
        )}
      >
        {children}
        <button
          type="button"
          aria-label="Hide tools panel"
          onClick={closeFromPanel}
          className="absolute top-2 right-2 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      </div>
    </>
  )
}
