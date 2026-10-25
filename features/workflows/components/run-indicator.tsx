"use client"

import { Spinner } from "@/components/ui/spinner"

export function RunIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-border/60 bg-card/90 px-3 py-1.5 text-xs font-medium shadow-sm backdrop-blur">
      <Spinner className="size-3.5 text-primary" />
      {label}
    </div>
  )
}
