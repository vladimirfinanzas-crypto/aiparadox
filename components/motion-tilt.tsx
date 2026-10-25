"use client"

import { MotionConfig, motion } from "motion/react"
import type { ReactNode } from "react"

// The ContainerScroll tablet's 3D entrance, reused on the section cards:
// each tips back and flattens as it scrolls into view. The initial state is
// unconditional so server and hydration render identical markup — branching
// on prefers-reduced-motion here caused a hydration mismatch; the user's
// motion preference is honored by MotionConfig instead (runtime only).
// transform-origin rides a class rather than motion's style so its string
// cannot drift between server and client either.
export function MotionTilt({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        initial={{ rotateX: 20, scale: 0.95, opacity: 0 }}
        whileInView={{ rotateX: 0, scale: 1, opacity: 1 }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        style={{ transformPerspective: 1000 }}
        className={`origin-top ${className ?? ""}`}
      >
        {children}
      </motion.div>
    </MotionConfig>
  )
}
