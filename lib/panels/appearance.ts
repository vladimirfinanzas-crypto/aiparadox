// ---------------------------------------------------------------------------
// Panel appearance — the visual half of a tool, kept as data.
//
// A panel's look is never free-form CSS: the person picks from a small, fixed
// set (icons, colours, layout, density) and the renderer turns those choices
// into a handful of classes and custom properties. That keeps three promises
// the visual editor depends on:
//
//   - nothing here can inject styles or scripts, because every value has to be
//     one of the whitelisted ids below;
//   - every panel stays recognisably Paradox, because the palette is ours;
//   - a saved appearance survives on any device, since it is stored in the same
//     config document as the blocks.
//
// Values are normalized on read: an old or hand-edited config with an unknown
// colour falls back to the default instead of rendering something broken.
// ---------------------------------------------------------------------------

import type { PanelDocument } from "./document"

export const panelIcons = [
  "layout-dashboard",
  "clipboard-list",
  "calendar",
  "check-square",
  "list-todo",
  "bar-chart-3",
  "globe",
  "sparkles",
  "wallet",
  "users",
  "inbox",
  "megaphone",
] as const
export type PanelIcon = (typeof panelIcons)[number]

/**
 * The safe palette. Each entry is what a person sees in the picker and the hex
 * the renderer writes into a CSS variable — never an arbitrary string from a
 * document, so there is no way to smuggle `background: url(…)` into a panel.
 */
export const panelColors = [
  { id: "primary", label: "Índigo", hex: "#6366f1", soft: "#eef2ff" },
  { id: "emerald", label: "Esmeralda", hex: "#10b981", soft: "#ecfdf5" },
  { id: "amber", label: "Ámbar", hex: "#f59e0b", soft: "#fffbeb" },
  { id: "rose", label: "Rosa", hex: "#f43f5e", soft: "#fff1f2" },
  { id: "sky", label: "Cielo", hex: "#0ea5e9", soft: "#f0f9ff" },
  { id: "violet", label: "Violeta", hex: "#8b5cf6", soft: "#f5f3ff" },
  { id: "slate", label: "Pizarra", hex: "#64748b", soft: "#f1f5f9" },
] as const
export type PanelColor = (typeof panelColors)[number]["id"]

export const panelLayouts = [
  { id: "single", label: "Una columna" },
  { id: "grid", label: "Dos columnas" },
  { id: "wide", label: "Ancho completo" },
] as const
export type PanelLayout = (typeof panelLayouts)[number]["id"]

export const panelDensities = [
  { id: "comfortable", label: "Cómodo" },
  { id: "compact", label: "Compacto" },
] as const
export type PanelDensity = (typeof panelDensities)[number]["id"]

export type PanelAppearance = {
  icon: PanelIcon
  /** Main colour: headings, accents, primary buttons. */
  color: PanelColor
  /** Surface behind the blocks. */
  background: PanelColor
  /** Highlight used by badges, stats and status. */
  accent: PanelColor
  layout: PanelLayout
  /** How much room blocks take: the size of the components. */
  density: PanelDensity
  /** The person's display preference: show the panel description or not. */
  showDescription: boolean
}

export const DEFAULT_APPEARANCE: PanelAppearance = {
  icon: "layout-dashboard",
  color: "primary",
  background: "slate",
  accent: "primary",
  layout: "single",
  density: "comfortable",
  showDescription: true,
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  const text = typeof value === "string" ? value.trim().toLowerCase() : ""
  return (allowed as readonly string[]).includes(text) ? (text as T) : fallback
}

/**
 * A whole appearance from an untrusted document: every field independently
 * checked against its whitelist, unknown fields dropped.
 */
export function normalizeAppearance(input: unknown): PanelAppearance {
  const raw =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}

  return {
    icon: oneOf(raw.icon, panelIcons, DEFAULT_APPEARANCE.icon),
    color: oneOf(raw.color, panelColors.map((entry) => entry.id), DEFAULT_APPEARANCE.color),
    background: oneOf(
      raw.background,
      panelColors.map((entry) => entry.id),
      DEFAULT_APPEARANCE.background
    ),
    accent: oneOf(raw.accent, panelColors.map((entry) => entry.id), DEFAULT_APPEARANCE.accent),
    layout: oneOf(
      raw.layout,
      panelLayouts.map((entry) => entry.id),
      DEFAULT_APPEARANCE.layout
    ),
    density: oneOf(
      raw.density,
      panelDensities.map((entry) => entry.id),
      DEFAULT_APPEARANCE.density
    ),
    showDescription:
      typeof raw.showDescription === "boolean"
        ? raw.showDescription
        : DEFAULT_APPEARANCE.showDescription,
  }
}

function colorHex(id: string): { hex: string; soft: string } {
  const found = panelColors.find((entry) => entry.id === id) ?? panelColors[0]
  return { hex: found.hex, soft: found.soft }
}

/**
 * The custom properties the renderer sets on the panel's root. Every value
 * comes from the palette above, so the document never reaches the style
 * attribute with raw text.
 */
export function appearanceCss(
  appearance: PanelAppearance
): Record<string, string> {
  const primary = colorHex(appearance.color)
  const background = colorHex(appearance.background)
  const accent = colorHex(appearance.accent)

  return {
    "--panel-primary": primary.hex,
    "--panel-accent": accent.hex,
    "--panel-surface": background.soft,
    "--panel-border": `${primary.hex}40`, // 25% alpha
  }
}

export function layoutClass(layout: PanelLayout): string {
  switch (layout) {
    case "grid":
      return "sm:grid-cols-2"
    case "wide":
      return ""
    case "single":
    default:
      return "max-w-3xl"
  }
}

export function densityGap(density: PanelDensity): string {
  return density === "compact" ? "gap-2" : "gap-4"
}

/** True when every field equals the default: used to skip a needless version. */
export function isDefaultAppearance(appearance: PanelAppearance): boolean {
  return (
    JSON.stringify(appearance) === JSON.stringify(DEFAULT_APPEARANCE)
  )
}

/** Reads the appearance from a document, tolerating panels saved before it. */
export function appearanceOf(document: PanelDocument): PanelAppearance {
  return document.appearance ?? DEFAULT_APPEARANCE
}
