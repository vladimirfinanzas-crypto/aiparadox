"use client"

import { useEffect } from "react"

import { Button } from "@/components/ui/button"

// Any failure inside the dashboard — the conversation history failing to
// query, a chat failing to open — lands here instead of a blank page. The
// person is told what happened and can retry; nothing pretends the data was
// loaded.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("Dashboard section failed to load", error)
  }, [error])

  return (
    <div
      role="alert"
      className="mx-auto flex h-svh w-full max-w-md flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">No se pudo cargar esta sección</p>
        <p className="text-xs text-muted-foreground">
          {error.message || "Ocurrió un error inesperado."}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={reset}>
        Volver a intentarlo
      </Button>
    </div>
  )
}
