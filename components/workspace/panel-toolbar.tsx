"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { HistoryIcon, RotateCcwIcon, SparklesIcon, Wand2Icon } from "lucide-react"
import { toast } from "sonner"

import { restoreWorkspaceVersionAction } from "@/actions/workspace"
import { GodfatherWorkspacePanel } from "@/components/workspace/godfather-workspace-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"

// ---------------------------------------------------------------------------
// The controls of one tool: ask Godfather to change it in place, and go back to
// an earlier layout. Both happen here; neither sends the person to the chat.
// ---------------------------------------------------------------------------

export type PanelVersionView = {
  version: number
  author: "user" | "godfather" | "migration"
  note: string | null
  blocks: number
  summary: string
  createdAtLabel: string
}

const authorLabels: Record<PanelVersionView["author"], string> = {
  user: "Tú",
  godfather: "Godfather",
  migration: "Versión inicial",
}

export function PanelToolbar({
  panelId,
  panelName,
  version,
  versions,
}: {
  panelId: string
  panelName: string
  version: number
  versions: PanelVersionView[]
}) {
  const router = useRouter()
  const [godfatherOpen, setGodfatherOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [restoring, startRestoring] = useTransition()
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null)

  const restore = (target: number) => {
    if (
      !window.confirm(
        `¿Volver a la versión ${target}? Se guardará como una versión nueva y los datos de los bloques que sigan existiendo se conservan.`
      )
    ) {
      return
    }

    setRestoringVersion(target)
    startRestoring(async () => {
      const result = await restoreWorkspaceVersionAction({ panelId, version: target })
      setRestoringVersion(null)

      if (!result.ok) {
        toast.error(result.error)
        return
      }

      toast.success(`Panel restaurado · versión ${result.version}`)
      setHistoryOpen(false)
      router.refresh()
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={() => setGodfatherOpen(true)}>
        <SparklesIcon data-icon="inline-start" />
        Cambiar con Godfather
      </Button>

      <Button variant="outline" onClick={() => setHistoryOpen(true)}>
        <HistoryIcon data-icon="inline-start" />
        Historial
        <span className="ml-1 text-[11px] text-muted-foreground">v{version}</span>
      </Button>

      <Sheet open={godfatherOpen} onOpenChange={setGodfatherOpen}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Cambiar esta herramienta</SheetTitle>
            <SheetDescription>
              Godfather trabaja sobre «{panelName}». Al aceptar el cambio se guarda
              como una versión nueva; lo que ya tienes escrito no se pierde.
            </SheetDescription>
          </SheetHeader>
          <GodfatherWorkspacePanel
            panelId={panelId}
            panelName={panelName}
            version={version}
            className="min-h-0 flex-1"
            onSaved={() => setGodfatherOpen(false)}
          />
        </SheetContent>
      </Sheet>

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Historial de «{panelName}»</SheetTitle>
            <SheetDescription>
              Cada cambio de estructura queda guardado. Volver a una versión no
              borra los datos de los bloques que siguen existiendo.
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {versions.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border/60 p-6 text-center text-xs text-muted-foreground">
                Todavía no hay versiones guardadas de esta herramienta.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {versions.map((item) => {
                  const current = item.version === version
                  return (
                    <li
                      key={item.version}
                      className="rounded-xl border border-border/50 bg-card/40 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">v{item.version}</span>
                          <Badge variant={current ? "default" : "outline"}>
                            {current ? "Actual" : authorLabels[item.author]}
                          </Badge>
                        </div>
                        <span className="text-[11px] text-muted-foreground">
                          {item.createdAtLabel}
                        </span>
                      </div>

                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {item.note ?? item.summary}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {item.blocks} {item.blocks === 1 ? "sección" : "secciones"}
                      </p>

                      {!current && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2 w-full gap-1.5"
                          disabled={restoring}
                          onClick={() => restore(item.version)}
                        >
                          {restoring && restoringVersion === item.version ? (
                            <Spinner />
                          ) : (
                            <RotateCcwIcon className="size-3.5" />
                          )}
                          Volver a esta versión
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div className="border-t border-border/60 p-4">
            <Button
              variant="outline"
              className="w-full gap-1.5"
              onClick={() => {
                setHistoryOpen(false)
                setGodfatherOpen(true)
              }}
            >
              <Wand2Icon className="size-3.5" />
              Pedir un cambio a Godfather
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
