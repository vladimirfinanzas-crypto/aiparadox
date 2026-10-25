"use client"

import { MotionConfig, motion } from "motion/react"
import type { ReactNode } from "react"

// Scroll-triggered fade-up used across the marketing landing sections. The
// initial state renders identically on server and client (no viewport
// branching) to avoid hydration mismatches; the user's reduced-motion
// preference is honored at runtime by MotionConfig, as in MotionTilt.
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode
  className?: string
  delay?: number
}) {
  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.2 }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay }}
        className={className}
      >
        {children}
      </motion.div>
    </MotionConfig>
  )
}
