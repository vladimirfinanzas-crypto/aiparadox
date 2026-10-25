"use client"

import { CanvasText } from "@/components/ui/canvas-text"

// The Paradox wordmark: brand text filled with the pale-blue brand tone
// (azul claro casi blanco) and crossed by waves in a blue alpha ramp
// (1 → 0.1) — the same single-hue construction Aceternity's demo uses
// for depth. One tuning point for every place the logo appears.
const WAVE_COLORS = [
  "rgba(37, 122, 255, 1)",
  "rgba(37, 122, 255, 0.9)",
  "rgba(37, 122, 255, 0.8)",
  "rgba(59, 130, 246, 0.7)",
  "rgba(59, 130, 246, 0.6)",
  "rgba(59, 130, 246, 0.5)",
  "rgba(96, 165, 250, 0.4)",
  "rgba(96, 165, 250, 0.3)",
  "rgba(125, 190, 255, 0.2)",
  "rgba(125, 190, 255, 0.1)",
]

export function ParadoxLogo({
  text,
  className,
  fillClassName = "bg-foreground",
}: {
  text: string
  className?: string
  fillClassName?: string
}) {
  // The wordmark always renders in caps: the canvas draws the raw string, so
  // the transform happens on the text itself, not via CSS.
  return (
    <CanvasText
      text={text.toUpperCase()}
      className={className}
      backgroundClassName={fillClassName}
      colors={WAVE_COLORS}
      animationDuration={20}
      lineWidth={1.2}
      lineGap={4}
      curveIntensity={14}
    />
  )
}
